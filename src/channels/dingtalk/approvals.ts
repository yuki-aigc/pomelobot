import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DingTalkConfig } from '../../config.js';
import type { Logger } from './types.js';
import { sendBySession, sendExecApprovalButtonCard, sendExecApprovalCard } from './client.js';
import type { ExecApprovalDecision, ExecApprovalMetadata, ExecApprovalRequest } from '../../agent.js';

type ApprovalContext = {
    dingtalkConfig: DingTalkConfig;
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    sessionWebhook: string;
    log: Logger;
};

type PendingApproval = {
    id: string;
    callId: string;
    cardInstanceId?: string;
    approvalKey: string;
    command: string;
    policyStatus: ExecApprovalRequest['policyStatus'];
    riskLevel: ExecApprovalRequest['riskLevel'];
    riskReasons: string[];
    resolve: (decision: ExecApprovalDecision) => void;
    timeout: NodeJS.Timeout;
    sessionWebhook: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    dingtalkConfig: DingTalkConfig;
    log: Logger;
    allowTextFallback?: boolean;
};

const approvalContext = new AsyncLocalStorage<ApprovalContext>();
// Multiple approvals can be pending at the same time for the same conversation/user.
// We keep a per-key list so we can handle id-less replies by defaulting to the latest approval.
const pendingApprovalIdsByKey = new Map<string, string[]>();
const pendingApprovalsById = new Map<string, PendingApproval>();
const pendingApprovalsByCard = new Map<string, PendingApproval>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function clipText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getApprovalKey(conversationId: string, senderId: string): string {
    return `${conversationId}:${senderId}`;
}

function addPendingId(approvalKey: string, approvalId: string) {
    const existing = pendingApprovalIdsByKey.get(approvalKey);
    if (existing) {
        existing.push(approvalId);
        return;
    }
    pendingApprovalIdsByKey.set(approvalKey, [approvalId]);
}

function removePendingId(approvalKey: string, approvalId: string) {
    const existing = pendingApprovalIdsByKey.get(approvalKey);
    if (!existing) return;
    const next = existing.filter((id) => id !== approvalId);
    if (next.length === 0) {
        pendingApprovalIdsByKey.delete(approvalKey);
        return;
    }
    pendingApprovalIdsByKey.set(approvalKey, next);
}

function getLatestPendingForKey(approvalKey: string): PendingApproval | undefined {
    const ids = pendingApprovalIdsByKey.get(approvalKey);
    if (!ids || ids.length === 0) return undefined;
    const lastId = ids[ids.length - 1];
    if (!lastId) return undefined;
    return pendingApprovalsById.get(lastId);
}

export function hasPendingApprovalForKey(conversationId: string, senderId: string): boolean {
    const approvalKey = getApprovalKey(conversationId, senderId);
    const ids = pendingApprovalIdsByKey.get(approvalKey);
    return Boolean(ids && ids.length > 0);
}

function parseApprovalDecision(text: string): { decision: 'approve' | 'reject'; id?: string; comment?: string } | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const isApprove =
        /^同意(?:\s|$|exec_)/.test(trimmed) ||
        /^批准(?:\s|$|exec_)/.test(trimmed) ||
        /^(approve|yes|y)\b/i.test(trimmed);
    const isReject =
        /^拒绝(?:\s|$|exec_)/.test(trimmed) ||
        /^不同意(?:\s|$|exec_)/.test(trimmed) ||
        /^(reject|no|n)\b/i.test(trimmed);
    if (!isApprove && !isReject) return null;

    // Support replies like:
    // - "同意 exec_0829f480"
    // - "拒绝 exec_0829f480"
    // - "同意 审批ID: exec_0829f480"
    const idMatch =
        trimmed.match(/\bexec_[0-9a-fA-F]{8}\b/) ||
        trimmed.match(/\b(?:id|ID|审批ID|审批id)[:\s=]*([a-zA-Z0-9_-]+)\b/);
    const id = idMatch ? (idMatch[1] ?? idMatch[0]) : undefined;
    let comment = '';
    if (id) {
        const index = trimmed.indexOf(id);
        if (index >= 0) {
            comment = trimmed.slice(index + id.length).trim();
        }
    } else {
        comment = trimmed.replace(/^(同意|批准|拒绝|不同意|approve|yes|y|reject|no|n)\b[:：\s-]*/i, '').trim();
    }
    comment = comment.replace(/^[:：,，\s-]+/, '').trim();

    return {
        decision: isApprove ? 'approve' : 'reject',
        id,
        comment: comment || undefined,
    };
}

function normalizeAction(value: unknown): string | null {
    if (!value) return null;
    const str = String(value).trim().toLowerCase();
    if (!str) return null;
    return str;
}

function tryParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
        return JSON.parse(trimmed);
    } catch {
        return value;
    }
}

function normalizeCallbackPayload(raw: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...raw };
    payload.data = tryParseJson(payload.data) as unknown;
    payload.content = tryParseJson(payload.content) as unknown;
    payload.callbackValue = tryParseJson(payload.callbackValue) as unknown;
    payload.cardData = tryParseJson(payload.cardData) as unknown;

    if (typeof payload.data === 'object' && payload.data) {
        const data = payload.data as Record<string, unknown>;
        if (!payload.cardInstanceId && data.cardInstanceId) {
            payload.cardInstanceId = data.cardInstanceId;
        }
        if (!payload.outTrackId && data.outTrackId) {
            payload.outTrackId = data.outTrackId;
        }
        if (!payload.cardData && data.cardData) {
            payload.cardData = tryParseJson(data.cardData) as unknown;
        }
        if (!payload.cardAction && data.cardAction) {
            payload.cardAction = tryParseJson(data.cardAction) as unknown;
        }
        if (!payload.callbackValue && data.callbackValue) {
            payload.callbackValue = tryParseJson(data.callbackValue) as unknown;
        }
    }

    return payload;
}

function extractApprovalFromCallback(payload: Record<string, unknown>): {
    approvalId?: string;
    callId?: string;
    action?: 'approve' | 'reject';
    cardInstanceId?: string;
    comment?: string;
    approverId?: string;
    approverName?: string;
} {
    const normalized = normalizeCallbackPayload(payload);
    // Card callbacks have multiple possible payload shapes; use permissive parsing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = normalized as Record<string, any>;
    const actionRaw =
        n.actionId ||
        n.actionKey ||
        n.action ||
        (Array.isArray(n.actionIds) ? n.actionIds[0] : undefined) ||
        // DingTalk card callbacks commonly wrap action info in cardPrivateData.
        (Array.isArray(n.cardPrivateData?.actionIds) ? n.cardPrivateData.actionIds[0] : undefined) ||
        n.cardPrivateData?.params?.actionId ||
        (Array.isArray(n.content?.cardPrivateData?.actionIds) ? n.content.cardPrivateData.actionIds[0] : undefined) ||
        n.content?.cardPrivateData?.params?.actionId ||
        (Array.isArray(n.value?.cardPrivateData?.actionIds) ? n.value.cardPrivateData.actionIds[0] : undefined) ||
        n.value?.cardPrivateData?.params?.actionId ||
        n.cardAction?.actionId ||
        n.cardAction?.actionKey ||
        n.cardAction?.action ||
        n.cardAction?.value?.actionId ||
        n.cardAction?.value?.actionKey ||
        n.cardAction?.value?.action ||
        n.callbackValue?.actionId ||
        n.callbackValue?.actionKey ||
        n.callbackValue?.action ||
        n.value?.action ||
        n.content?.action;

    const action = normalizeAction(actionRaw);
    const actionDecision =
        action && action.includes('approve') ? 'approve' : action && action.includes('reject') ? 'reject' : undefined;

    const cardInstanceId =
        (n.cardInstanceId as string | undefined) ||
        (n.cardInstanceID as string | undefined) ||
        (n.outTrackId as string | undefined);

    const approvalId =
        (n.approvalId as string | undefined) ||
        (n.cardData?.cardParamMap?.approvalId as string | undefined) ||
        (n.cardParamMap?.approvalId as string | undefined);
    const callId =
        (n.callId as string | undefined) ||
        (n.cardData?.cardParamMap?.callId as string | undefined) ||
        (n.cardParamMap?.callId as string | undefined);
    const comment =
        (n.comment as string | undefined) ||
        (n.reason as string | undefined) ||
        (n.remark as string | undefined) ||
        (n.cardData?.cardParamMap?.comment as string | undefined) ||
        (n.cardParamMap?.comment as string | undefined);
    const approverId =
        (n.staffId as string | undefined) ||
        (n.userId as string | undefined) ||
        (n.operatorId as string | undefined) ||
        (n.operatorStaffId as string | undefined);
    const approverName =
        (n.operatorName as string | undefined) ||
        (n.nick as string | undefined) ||
        (n.senderNick as string | undefined);

    return { approvalId, callId, action: actionDecision, cardInstanceId, comment, approverId, approverName };
}

function buildDecisionMetadata(
    pending: PendingApproval,
    source: ExecApprovalMetadata['decisionSource'],
    extras?: Partial<ExecApprovalMetadata>
): ExecApprovalMetadata {
    return {
        channel: 'dingtalk',
        callId: pending.callId,
        approvalId: pending.id,
        cardInstanceId: pending.cardInstanceId,
        decisionSource: source,
        approverId: pending.senderId,
        approverName: pending.senderName,
        decidedAt: new Date().toISOString(),
        ...extras,
    };
}

function resolveApproval(pending: PendingApproval, decision: ExecApprovalDecision) {
    // Guard against double-resolve from concurrent callbacks/timeouts.
    if (!pendingApprovalsById.has(pending.id)) {
        return;
    }

    clearTimeout(pending.timeout);
    pending.resolve(decision);
    removePendingId(pending.approvalKey, pending.id);
    pendingApprovalsById.delete(pending.id);
    if (pending.cardInstanceId) {
        pendingApprovalsByCard.delete(pending.cardInstanceId);
    }
}

export function withApprovalContext<T>(
    ctx: ApprovalContext,
    fn: () => Promise<T>
): Promise<T> {
    return approvalContext.run(ctx, fn);
}

export async function requestDingTalkExecApproval(params: ExecApprovalRequest): Promise<ExecApprovalDecision> {
    const ctx = approvalContext.getStore();
    if (!ctx) {
        return {
            decision: 'reject',
            comment: '审批上下文不存在',
            metadata: {
                channel: 'system',
                callId: params.callId,
                decisionSource: 'system',
                decidedAt: new Date().toISOString(),
            },
        };
    }

    const approvalsEnabled = ctx.dingtalkConfig.execApprovals?.enabled === true;
    if (!approvalsEnabled) {
        return {
            decision: 'approve',
            metadata: {
                channel: 'system',
                callId: params.callId,
                decisionSource: 'system',
                approverName: 'dingtalk-auto-approve',
                decidedAt: new Date().toISOString(),
            },
        };
    }

    const approvalId = `exec_${randomUUID().slice(0, 8)}`;
    const timeoutMs = ctx.dingtalkConfig.execApprovals?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const approvalKey = getApprovalKey(ctx.conversationId, ctx.senderId);
    const mode = ctx.dingtalkConfig.execApprovals?.mode ?? 'button';

    if (mode === 'button' && !ctx.dingtalkConfig.execApprovals?.templateId) {
        await sendBySession(
            ctx.dingtalkConfig,
            ctx.sessionWebhook,
            '❌ Exec 审批已开启，但未配置按钮卡片模板 ID（dingtalk.execApprovals.templateId）',
            { atUserId: !ctx.isDirect ? ctx.senderId : null },
            ctx.log
        );
        return {
            decision: 'reject',
            comment: '审批模板配置缺失',
            metadata: {
                channel: 'dingtalk',
                callId: params.callId,
                approvalId,
                decisionSource: 'system',
                approverId: ctx.senderId,
                approverName: ctx.senderName,
                decidedAt: new Date().toISOString(),
            },
        };
    }

    return new Promise((resolve) => {
        const pending: PendingApproval = {
            id: approvalId,
            callId: params.callId,
            approvalKey,
            command: params.command,
            policyStatus: params.policyStatus,
            riskLevel: params.riskLevel,
            riskReasons: params.riskReasons,
            resolve,
            timeout: undefined as unknown as NodeJS.Timeout,
            sessionWebhook: ctx.sessionWebhook,
            isDirect: ctx.isDirect,
            senderId: ctx.senderId,
            senderName: ctx.senderName,
            dingtalkConfig: ctx.dingtalkConfig,
            log: ctx.log,
            allowTextFallback: mode === 'text',
        };

        pending.timeout = setTimeout(
            () =>
                resolveApproval(pending, {
                    decision: 'reject',
                    comment: '审批超时',
                    metadata: buildDecisionMetadata(pending, 'system'),
                }),
            timeoutMs
        );
        pendingApprovalsById.set(approvalId, pending);
        addPendingId(approvalKey, approvalId);

        (async () => {
            if (mode === 'button') {
                const cardParams = {
                    approvalId,
                    callId: params.callId,
                    command: params.command,
                    cwd: params.cwd,
                    timeoutMs: String(params.timeoutMs),
                    senderName: ctx.senderName,
                    policyStatus: params.policyStatus,
                    riskLevel: params.riskLevel,
                    riskReasons: clipText(params.riskReasons.join('; '), 300),
                };
                try {
                    const cardResult = await sendExecApprovalButtonCard(
                        ctx.dingtalkConfig,
                        ctx.conversationId,
                        ctx.isDirect,
                        ctx.senderId,
                        cardParams,
                        ctx.log
                    );
                    pending.cardInstanceId = cardResult.cardInstanceId;
                    pendingApprovalsByCard.set(cardResult.cardInstanceId, pending);
                    return;
                } catch (err) {
                    pending.allowTextFallback = true;
                    const e = err as { response?: { status?: number; data?: unknown } };
                    const safe = (value: unknown) => {
                        try { return JSON.stringify(value); } catch { return '\"[unserializable]\"'; }
                    };
                    ctx.log.warn?.(
                        `[DingTalk] Exec approval button card failed, fallback to text (status=${e.response?.status ?? 'n/a'}, data=${safe(e.response?.data)}): ${String(err)}`
                    );

                    const approvalContent = [
                        '### Exec 审批请求（按钮失败，文本审批）',
                        '',
                        `- 审批ID: \`${approvalId}\``,
                        `- 调用ID: \`${params.callId}\``,
                        `- 操作人: ${ctx.senderName}`,
                        `- 命令: \`${params.command}\``,
                        `- 目录: \`${params.cwd}\``,
                        `- 超时: ${params.timeoutMs}ms`,
                        `- 策略状态: ${params.policyStatus}${params.policyReason ? ` (${params.policyReason})` : ''}`,
                        `- 风险等级: ${params.riskLevel}`,
                        ...(params.riskReasons.length > 0 ? [`- 风险提示: ${params.riskReasons.join('; ')}`] : []),
                        '',
                        '请回复以下任一指令：',
                        `- 同意 ${approvalId}`,
                        `- 拒绝 ${approvalId} [原因]`,
                    ].join('\n');

                    await sendExecApprovalCard(
                        ctx.dingtalkConfig,
                        ctx.conversationId,
                        ctx.isDirect,
                        ctx.senderId,
                        approvalContent,
                        ctx.log
                    );
                    return;
                }
            }

            // Text mode
            const approvalContent = [
                '### Exec 审批请求',
                '',
                `- 审批ID: \`${approvalId}\``,
                `- 调用ID: \`${params.callId}\``,
                `- 操作人: ${ctx.senderName}`,
                `- 命令: \`${params.command}\``,
                `- 目录: \`${params.cwd}\``,
                `- 超时: ${params.timeoutMs}ms`,
                `- 策略状态: ${params.policyStatus}${params.policyReason ? ` (${params.policyReason})` : ''}`,
                `- 风险等级: ${params.riskLevel}`,
                ...(params.riskReasons.length > 0 ? [`- 风险提示: ${params.riskReasons.join('; ')}`] : []),
                '',
                '请回复以下任一指令：',
                `- 同意 ${approvalId}`,
                `- 拒绝 ${approvalId} [原因]`,
            ].join('\n');

            await sendExecApprovalCard(
                ctx.dingtalkConfig,
                ctx.conversationId,
                ctx.isDirect,
                ctx.senderId,
                approvalContent,
                ctx.log
            );
        })().catch((err) => {
            // If we fail to notify the user, don't leave the tool call hanging.
            ctx.log.error?.(`[DingTalk] Exec approval notification failed: ${String(err)}`);
            resolveApproval(pending, {
                decision: 'reject',
                comment: '审批通知发送失败',
                metadata: buildDecisionMetadata(pending, 'system'),
            });
        });
    });
}

export async function tryHandleExecApprovalReply(params: {
    text: string;
    conversationId: string;
    senderId: string;
    sessionWebhook: string;
    isDirect: boolean;
    dingtalkConfig: DingTalkConfig;
    log: Logger;
}): Promise<boolean> {
    const approvalKey = getApprovalKey(params.conversationId, params.senderId);
    const decision = parseApprovalDecision(params.text);
    if (!decision) return false;

    if (!decision.id) {
        const ids = pendingApprovalIdsByKey.get(approvalKey);
        if (ids && ids.length > 1) {
            const latest = ids[ids.length - 1];
            await sendBySession(
                params.dingtalkConfig,
                params.sessionWebhook,
                `⚠️ 当前有 ${ids.length} 个待处理审批，请在回复中带上审批ID，例如：同意 ${latest}`,
                { atUserId: !params.isDirect ? params.senderId : null },
                params.log
            );
            return true;
        }
    }

    const pending = decision.id
        ? pendingApprovalsById.get(decision.id)
        : getLatestPendingForKey(approvalKey);
    if (!pending) {
        // If user explicitly referenced an approval ID, treat it as handled even if it's missing,
        // otherwise the message would fall through to the main agent and cause confusion.
        if (decision.id) {
            await sendBySession(
                params.dingtalkConfig,
                params.sessionWebhook,
                `❌ 未找到待处理审批（ID: ${decision.id}），可能已过期或已处理。`,
                { atUserId: !params.isDirect ? params.senderId : null },
                params.log
            );
            return true;
        }
        return false;
    }
    // Prevent cross-conversation approval by ID.
    if (pending.approvalKey !== approvalKey) {
        if (decision.id) {
            await sendBySession(
                params.dingtalkConfig,
                params.sessionWebhook,
                `❌ 审批ID无效或不属于当前会话（ID: ${decision.id}）。`,
                { atUserId: !params.isDirect ? params.senderId : null },
                params.log
            );
            return true;
        }
        return false;
    }

    // If user doesn't specify an ID, only accept text approvals when explicitly configured
    // or when we've fallen back from a failed button card.
    if (!decision.id) {
        const mode = params.dingtalkConfig.execApprovals?.mode ?? 'button';
        if (mode !== 'text' && !pending.allowTextFallback) return false;
    }

    const result: ExecApprovalDecision =
        decision.decision === 'approve'
            ? {
                decision: 'approve',
                comment: decision.comment,
                metadata: buildDecisionMetadata(pending, 'text', {
                    approverId: params.senderId,
                }),
            }
            : {
                decision: 'reject',
                comment: decision.comment,
                metadata: buildDecisionMetadata(pending, 'text', {
                    approverId: params.senderId,
                }),
            };
    resolveApproval(pending, result);

    const commandSnippet = pending.command.length > 200
        ? `${pending.command.slice(0, 197)}...`
        : pending.command;
    const ackText =
        decision.decision === 'approve'
            ? `✅ 已批准执行（审批ID: ${pending.id}）\n调用ID: \`${pending.callId}\`\n命令: \`${commandSnippet}\`${decision.comment ? `\n备注: ${decision.comment}` : ''}`
            : `❌ 已拒绝执行（审批ID: ${pending.id}）\n调用ID: \`${pending.callId}\`\n命令: \`${commandSnippet}\`${decision.comment ? `\n原因: ${decision.comment}` : ''}`;

    await sendBySession(
        params.dingtalkConfig,
        params.sessionWebhook,
        ackText,
        { atUserId: !params.isDirect ? params.senderId : null },
        params.log
    );

    return true;
}

export async function tryHandleExecApprovalCardCallback(params: {
    payload: Record<string, unknown>;
    log: Logger;
}): Promise<boolean> {
    const extracted = extractApprovalFromCallback(params.payload);
    params.log.debug?.(`[DingTalk] Card callback extracted: ${JSON.stringify(extracted)}`);
    const pending =
        (extracted.cardInstanceId && pendingApprovalsByCard.get(extracted.cardInstanceId)) ||
        (extracted.approvalId && pendingApprovalsById.get(extracted.approvalId));

    if (!pending || !extracted.action) {
        return false;
    }
    if (extracted.callId && extracted.callId !== pending.callId) {
        params.log.warn?.(
            `[DingTalk] Approval callback callId mismatch. expected=${pending.callId}, got=${extracted.callId}`
        );
        return false;
    }

    const result: ExecApprovalDecision =
        extracted.action === 'approve'
            ? {
                decision: 'approve',
                comment: extracted.comment,
                metadata: buildDecisionMetadata(pending, 'button', {
                    approverId: extracted.approverId || pending.senderId,
                    approverName: extracted.approverName || pending.senderName,
                    cardInstanceId: extracted.cardInstanceId || pending.cardInstanceId,
                }),
            }
            : {
                decision: 'reject',
                comment: extracted.comment,
                metadata: buildDecisionMetadata(pending, 'button', {
                    approverId: extracted.approverId || pending.senderId,
                    approverName: extracted.approverName || pending.senderName,
                    cardInstanceId: extracted.cardInstanceId || pending.cardInstanceId,
                }),
            };
    resolveApproval(pending, result);

    const commandSnippet = pending.command.length > 200
        ? `${pending.command.slice(0, 197)}...`
        : pending.command;
    const ackText =
        extracted.action === 'approve'
            ? `✅ 已批准执行（审批ID: ${pending.id}）\n调用ID: \`${pending.callId}\`\n命令: \`${commandSnippet}\`${extracted.comment ? `\n备注: ${extracted.comment}` : ''}`
            : `❌ 已拒绝执行（审批ID: ${pending.id}）\n调用ID: \`${pending.callId}\`\n命令: \`${commandSnippet}\`${extracted.comment ? `\n原因: ${extracted.comment}` : ''}`;

    await sendBySession(
        pending.dingtalkConfig,
        pending.sessionWebhook,
        ackText,
        { atUserId: !pending.isDirect ? pending.senderId : null },
        pending.log
    );

    return true;
}
