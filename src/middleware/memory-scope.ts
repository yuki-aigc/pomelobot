import type { AgentMemorySessionIsolationConfig } from '../config.js';
import { getDingTalkConversationContext } from '../channels/dingtalk/context.js';

export type MemoryScopeKind = 'main' | 'direct' | 'group';

export interface MemoryScope {
    key: string;
    kind: MemoryScopeKind;
}

function sanitizeScopePart(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return 'unknown';
    return trimmed.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function resolveMemoryScope(config: AgentMemorySessionIsolationConfig): MemoryScope {
    const context = getDingTalkConversationContext();
    if (!context || !config.enabled) {
        return { key: 'main', kind: 'main' };
    }

    if (context.isDirect) {
        if (config.direct_scope === 'direct') {
            return {
                key: `direct_${sanitizeScopePart(context.senderId)}`,
                kind: 'direct',
            };
        }
        return { key: 'main', kind: 'main' };
    }

    return {
        key: `${config.group_scope_prefix}${sanitizeScopePart(context.conversationId)}`,
        kind: 'group',
    };
}
