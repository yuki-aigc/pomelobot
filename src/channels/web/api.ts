import { randomUUID } from 'node:crypto';
import type { WebConnectionState, WebHelloPayload, WebMessagePayload } from './types.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9:_-]{8,128}$/;

function pickTrimmedString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}

export function createWebSessionId(): string {
    return `wsn_${randomUUID().replace(/-/g, '')}`;
}

export function normalizeWebSessionId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (!SESSION_ID_PATTERN.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

export function resolveWebUserId(value: {
    user_id?: string;
    userId?: string;
    sender_id?: string;
    senderId?: string;
}, fallback?: string): string | undefined {
    return pickTrimmedString(value.user_id, value.userId, value.sender_id, value.senderId, fallback);
}

export function resolveWebNickName(value: {
    nick_name?: string;
    nickName?: string;
    userName?: string;
    senderName?: string;
}, fallback?: string): string | undefined {
    return pickTrimmedString(value.nick_name, value.nickName, value.userName, value.senderName, fallback);
}

export function resolveWebSessionValue(value: {
    session_id?: string;
    sessionId?: string;
    conversationId?: string;
}, fallback?: string): string | undefined {
    return normalizeWebSessionId(
        pickTrimmedString(value.session_id, value.sessionId, value.conversationId, fallback),
    );
}

export function resolveWebTitle(value: {
    session_title?: string;
    sessionTitle?: string;
    conversationTitle?: string;
}, fallback?: string): string | undefined {
    return pickTrimmedString(value.session_title, value.sessionTitle, value.conversationTitle, fallback);
}

export function resolveHelloIdentity(
    payload: WebHelloPayload,
    state: WebConnectionState,
): {
    clientId?: string;
    userId: string;
    nickName: string;
    requestedSessionId?: string;
    sessionTitle?: string;
    isDirect: boolean;
} {
    const userId = resolveWebUserId(payload, state.userId) || `web-user-${state.connectionId}`;
    const nickName = resolveWebNickName(payload, state.userName) || 'Web User';
    return {
        clientId: pickTrimmedString(payload.client_id, payload.clientId, state.clientId),
        userId,
        nickName,
        requestedSessionId: resolveWebSessionValue(payload, state.conversationId),
        sessionTitle: resolveWebTitle(payload, state.conversationTitle),
        isDirect: typeof payload.isDirect === 'boolean' ? payload.isDirect : (state.isDirect ?? true),
    };
}

export function resolveMessageIdentity(
    payload: WebMessagePayload,
    state: WebConnectionState,
): {
    messageId: string;
    idempotencyKey: string;
    userId: string;
    nickName: string;
    requestedSessionId?: string;
    sessionTitle?: string;
    isDirect: boolean;
    timestamp: number;
} {
    const messageId = pickTrimmedString(payload.message_id, payload.messageId, payload.request_id)
        || `web-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return {
        messageId,
        idempotencyKey: pickTrimmedString(payload.idempotency_key, payload.idempotencyKey, payload.request_id) || messageId,
        userId: resolveWebUserId(payload, state.userId) || `web-user-${state.connectionId}`,
        nickName: resolveWebNickName(payload, state.userName) || 'Web User',
        requestedSessionId: resolveWebSessionValue(payload, state.conversationId),
        sessionTitle: resolveWebTitle(payload, state.conversationTitle),
        isDirect: payload.isDirect ?? state.isDirect ?? true,
        timestamp: payload.timestamp || Date.now(),
    };
}

export interface WebSessionRecord {
    sessionId: string;
    userId: string;
    nickName: string;
    sessionTitle?: string;
    createdAt: number;
    lastSeenAt: number;
}

export interface WebSessionBindRequest {
    requestedSessionId?: string;
    userId: string;
    nickName?: string;
    sessionTitle?: string;
    now?: number;
}

export type WebSessionBindResult =
    | { ok: true; created: boolean; session: WebSessionRecord }
    | { ok: false; code: 'bad_session_id' | 'session_conflict'; reason: string };

export class WebSessionRegistry {
    private readonly sessions = new Map<string, WebSessionRecord>();

    bind(request: WebSessionBindRequest): WebSessionBindResult {
        const now = request.now ?? Date.now();
        const requested = request.requestedSessionId;
        if (requested && !normalizeWebSessionId(requested)) {
            return {
                ok: false,
                code: 'bad_session_id',
                reason: 'session_id 非法。只允许 8-128 位字母、数字、冒号、下划线、中划线。',
            };
        }

        const sessionId = normalizeWebSessionId(requested) || createWebSessionId();
        const existing = this.sessions.get(sessionId);
        if (existing && existing.userId !== request.userId) {
            return {
                ok: false,
                code: 'session_conflict',
                reason: `session_id=${sessionId} 已绑定到其他 user_id，禁止跨用户复用。`,
            };
        }

        if (existing) {
            existing.lastSeenAt = now;
            if (request.nickName) {
                existing.nickName = request.nickName;
            }
            if (request.sessionTitle) {
                existing.sessionTitle = request.sessionTitle;
            }
            return {
                ok: true,
                created: false,
                session: existing,
            };
        }

        const created: WebSessionRecord = {
            sessionId,
            userId: request.userId,
            nickName: request.nickName || request.userId,
            sessionTitle: request.sessionTitle,
            createdAt: now,
            lastSeenAt: now,
        };
        this.sessions.set(sessionId, created);
        return {
            ok: true,
            created: true,
            session: created,
        };
    }

    clear(): void {
        this.sessions.clear();
    }
}
