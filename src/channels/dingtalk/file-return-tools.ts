import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDingTalkConversationContext, queueDingTalkReplyFile } from './context.js';
import { sendTemplateCard } from './client.js';
import type { Logger } from './types.js';
import type { DingTalkConfig } from '../../config.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function isPathInsideDir(filePath: string, dirPath: string): boolean {
    const normalizedDir = path.resolve(dirPath);
    const normalizedFile = path.resolve(filePath);
    return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}${path.sep}`);
}

function resolvePathFromWorkspace(workspaceRoot: string, rawPath: string): string {
    const candidate = rawPath.trim();
    if (!candidate) {
        throw new Error('path 不能为空');
    }
    if (path.isAbsolute(candidate)) {
        return path.resolve(candidate);
    }
    if (candidate.startsWith('workspace/')) {
        return path.resolve(process.cwd(), candidate);
    }
    return path.resolve(workspaceRoot, candidate);
}

function sanitizeFileName(fileName: string): string {
    return fileName
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || `reply-${Date.now()}.txt`;
}

function resolveTemplateId(override?: string): string {
    const fromArgs = override?.trim();
    if (fromArgs) return fromArgs;
    const fromEnv = process.env.DINGTALK_BILL_CARD_TEMPLATE_ID?.trim();
    if (fromEnv) return fromEnv;
    throw new Error('缺少卡片模板 ID，请传入 templateId 或配置 DINGTALK_BILL_CARD_TEMPLATE_ID');
}

function asCardParamMap(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('cardParamMap 必须是 JSON 对象');
    }
    return value as Record<string, unknown>;
}

async function loadCardParamMapFromFile(workspaceRoot: string, rawPath: string): Promise<Record<string, unknown>> {
    const resolved = resolvePathFromWorkspace(workspaceRoot, rawPath);
    const content = await fsPromises.readFile(resolved, 'utf8');
    return asCardParamMap(JSON.parse(content));
}

type SendCardArgs = {
    templateId?: string;
    cardParamMap?: Record<string, unknown>;
    cardParamMapPath?: string;
};

function asSendCardArgs(value: unknown): SendCardArgs {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('argsPath 内容必须是 JSON 对象');
    }
    const obj = value as Record<string, unknown>;
    const templateId = typeof obj.templateId === 'string' ? obj.templateId : undefined;
    const cardParamMapPath = typeof obj.cardParamMapPath === 'string' ? obj.cardParamMapPath : undefined;
    const rawCardParamMap = obj.cardParamMap;
    const cardParamMap = rawCardParamMap == null ? undefined : asCardParamMap(rawCardParamMap);
    if (!cardParamMapPath && !cardParamMap) {
        throw new Error('argsPath 中至少包含 cardParamMapPath 或 cardParamMap');
    }
    return {
        templateId,
        cardParamMap,
        cardParamMapPath,
    };
}

async function loadSendCardArgsFromFile(workspaceRoot: string, rawPath: string): Promise<SendCardArgs> {
    const resolved = resolvePathFromWorkspace(workspaceRoot, rawPath);
    const content = await fsPromises.readFile(resolved, 'utf8');
    return asSendCardArgs(JSON.parse(content));
}

export function createDingTalkFileReturnTools(
    workspaceRoot: string,
    dingtalkConfig?: DingTalkConfig,
    log?: Logger
) {
    const workspaceTmpRoot = path.resolve(workspaceRoot, 'tmp');

    const dingtalkWriteTmpFile = tool(
        async ({ fileName, content }: { fileName: string; content: string }) => {
            const context = getDingTalkConversationContext();
            if (!context) {
                return '❌ 当前不是 DingTalk 会话，无法使用 dingtalk_write_tmp_file。';
            }
            const safeName = sanitizeFileName(fileName);
            const targetPath = path.resolve(workspaceTmpRoot, safeName);
            if (!isPathInsideDir(targetPath, workspaceTmpRoot)) {
                return '❌ 文件路径非法，只允许写入 workspace/tmp。';
            }

            await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
            await fsPromises.writeFile(targetPath, content, 'utf8');

            const stat = await fsPromises.stat(targetPath);
            if (stat.size <= 0) {
                return `⚠️ 文件写入成功但为空: ${targetPath}`;
            }
            if (stat.size > MAX_FILE_BYTES) {
                return `⚠️ 文件已写入但超过 10MB，不能回传: ${targetPath}`;
            }
            queueDingTalkReplyFile(targetPath);
            return `✅ 文件已写入并登记回传: ${targetPath}`;
        },
        {
            name: 'dingtalk_write_tmp_file',
            description: '将文本内容写入 workspace/tmp 下文件并登记为待回传附件（仅 DingTalk 会话可用）。',
            schema: z.object({
                fileName: z.string().describe('文件名（例如 report.md 或 result.json），仅会写入 workspace/tmp'),
                content: z.string().describe('文件内容'),
            }),
        }
    );

    const dingtalkSendFile = tool(
        async ({ path: rawPath }: { path: string }) => {
            const context = getDingTalkConversationContext();
            if (!context) {
                return '❌ 当前不是 DingTalk 会话，无法使用 dingtalk_send_file。';
            }
            const resolved = resolvePathFromWorkspace(workspaceRoot, rawPath);
            if (!isPathInsideDir(resolved, workspaceTmpRoot)) {
                return `❌ 仅允许回传 workspace/tmp 下文件。当前路径: ${resolved}`;
            }

            let stat;
            try {
                stat = await fsPromises.stat(resolved);
            } catch {
                return `❌ 文件不存在: ${resolved}`;
            }
            if (!stat.isFile()) {
                return `❌ 目标不是文件: ${resolved}`;
            }
            if (stat.size <= 0) {
                return `❌ 文件为空: ${resolved}`;
            }
            if (stat.size > MAX_FILE_BYTES) {
                return `❌ 文件超过 10MB 限制: ${resolved}`;
            }

            queueDingTalkReplyFile(resolved);
            return `✅ 已登记回传文件: ${resolved}`;
        },
        {
            name: 'dingtalk_send_file',
            description: '登记回传附件。只接受 workspace/tmp 下且 <=10MB 的文件（仅 DingTalk 会话可用）。',
            schema: z.object({
                path: z.string().describe('待回传文件路径（建议使用 workspace/tmp/...）'),
            }),
        }
    );

    const dingtalkSendCard = tool(
        async ({
            templateId,
            cardParamMap,
            cardParamMapPath,
            argsPath,
        }: {
            templateId?: string;
            cardParamMap?: Record<string, unknown>;
            cardParamMapPath?: string;
            argsPath?: string;
        }) => {
            const context = getDingTalkConversationContext();
            if (!context) {
                return '❌ 当前不是 DingTalk 会话，无法使用 dingtalk_send_card。';
            }
            if (!dingtalkConfig?.clientId || !dingtalkConfig?.clientSecret) {
                return '❌ dingtalk.clientId/clientSecret 未配置，无法发送卡片。';
            }

            try {
                const argsFile = argsPath ? await loadSendCardArgsFromFile(workspaceRoot, argsPath) : undefined;
                const finalTemplateId = resolveTemplateId(templateId || argsFile?.templateId);

                const finalCardParamMapPath = cardParamMapPath || argsFile?.cardParamMapPath;
                const finalCardParamMapValue = cardParamMap ?? argsFile?.cardParamMap;
                const finalCardParamMap = finalCardParamMapPath
                    ? await loadCardParamMapFromFile(workspaceRoot, finalCardParamMapPath)
                    : asCardParamMap(finalCardParamMapValue);

                const result = await sendTemplateCard(
                    dingtalkConfig,
                    context.conversationId,
                    context.isDirect,
                    context.senderId,
                    finalTemplateId,
                    finalCardParamMap,
                    log,
                );
                return `✅ 卡片已发送，cardInstanceId=${result.cardInstanceId}`;
            } catch (error) {
                log?.error?.(`[DingTalk][AICard] dingtalk_send_card failed: ${error instanceof Error ? error.message : String(error)}`);
                return `❌ 发送卡片失败: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
        {
            name: 'dingtalk_send_card',
            description: '在当前 DingTalk 会话发送模板卡片（自动路由到当前用户或当前群）。',
            schema: z.object({
                templateId: z.string().optional().describe('卡片模板 ID。可选，未传时读取 DINGTALK_BILL_CARD_TEMPLATE_ID。'),
                cardParamMap: z.record(z.any()).optional().describe('卡片字段映射（JSON 对象）。'),
                cardParamMapPath: z.string().optional().describe('卡片字段映射 JSON 文件路径（可替代 cardParamMap）。'),
                argsPath: z.string().optional().describe('发送参数文件路径（JSON，支持 templateId/cardParamMap/cardParamMapPath）。'),
            }).refine((value) => Boolean(value.cardParamMap || value.cardParamMapPath || value.argsPath), {
                message: 'cardParamMap、cardParamMapPath、argsPath 至少提供一个',
            }),
        }
    );

    return [dingtalkWriteTmpFile, dingtalkSendFile, dingtalkSendCard];
}
