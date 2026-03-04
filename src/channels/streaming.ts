const MINIMAX_TOOL_CALL_TAG_PATTERN = /<\s*minimax:tool_call\b[\s\S]*?(?:<\/\s*minimax:tool_call\s*>|$)/gi;
const MINIMAX_TOOL_CALL_CLOSE_TAG_PATTERN = /<\/\s*minimax:tool_call\s*>/gi;
const GENERIC_TOOL_CALL_BLOCK_PATTERN = /<\s*tool_call\b[\s\S]*?(?:<\/\s*tool_call\s*>|$)/gi;
const GENERIC_TOOL_CALL_TAG_PATTERN = /<\s*\/?\s*tool_call\b[^>]*>/gi;
const TOOL_CALL_HINT_PATTERN = /\[\s*调用工具:[^\]\n]*\]/g;
const TOOL_CALL_INLINE_NAME_PATTERN = /\[\s*调用\s+name=["'][^"']+["'][^\]\n]*\]/g;
const TOOL_CALL_TRAIL_PATTERN = /\[\s*调用(?:工具|参数)?:[^\n]*/g;
const TOOL_CALL_RESIDUE_PATTERN = /(调用工具|调用参数|tool_call|minimax:tool_call|^\s*调用\s+name=|^\s*name\s*=\s*["'])/i;

export function sanitizeUserFacingText(text: string): string {
    if (!text) return '';

    let cleaned = text;
    cleaned = cleaned.replace(MINIMAX_TOOL_CALL_TAG_PATTERN, '');
    cleaned = cleaned.replace(MINIMAX_TOOL_CALL_CLOSE_TAG_PATTERN, '');
    cleaned = cleaned.replace(GENERIC_TOOL_CALL_BLOCK_PATTERN, '');
    cleaned = cleaned.replace(GENERIC_TOOL_CALL_TAG_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_HINT_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_INLINE_NAME_PATTERN, '');
    cleaned = cleaned.replace(TOOL_CALL_TRAIL_PATTERN, '');
    cleaned = cleaned
        .split('\n')
        .filter((line) => !TOOL_CALL_RESIDUE_PATTERN.test(line.trim()))
        .join('\n');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

export function extractTextBlocks(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }

    if (content && typeof content === 'object' && !Array.isArray(content)) {
        const obj = content as {
            text?: unknown;
            content?: unknown;
            kwargs?: { text?: unknown; content?: unknown };
        };
        if (typeof obj.text === 'string' && obj.text.trim()) {
            return obj.text.trim();
        }
        if (obj.content !== undefined) {
            return extractTextBlocks(obj.content);
        }
        if (obj.kwargs) {
            if (obj.kwargs.content !== undefined) {
                return extractTextBlocks(obj.kwargs.content);
            }
            if (obj.kwargs.text !== undefined) {
                return extractTextBlocks(obj.kwargs.text);
            }
        }
        return '';
    }

    if (!Array.isArray(content)) {
        return '';
    }

    const blocks: string[] = [];
    for (const item of content) {
        if (typeof item === 'string') {
            blocks.push(item);
            continue;
        }
        if (!item || typeof item !== 'object') {
            continue;
        }
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
            blocks.push(text);
        }
    }
    return blocks.join('\n').trim();
}

export function extractStreamChunkText(content: unknown): string {
    return extractTextBlocks(content);
}

export function extractReplyTextFromEventData(data: unknown, depth: number = 0): string {
    if (!data || depth > 3) {
        return '';
    }

    if (typeof data === 'string' || Array.isArray(data)) {
        return extractTextBlocks(data);
    }

    if (typeof data !== 'object') {
        return '';
    }

    const record = data as Record<string, unknown> & {
        kwargs?: { content?: unknown; output?: unknown; messages?: unknown };
    };

    const directContent = extractTextBlocks(
        record.content !== undefined ? record.content : record.kwargs?.content
    );
    if (directContent) {
        return directContent;
    }

    const messages = Array.isArray(record.messages)
        ? record.messages
        : Array.isArray(record.kwargs?.messages)
            ? record.kwargs.messages
            : null;

    if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1] as { content?: unknown } | undefined;
        if (lastMessage) {
            const messageContent = extractTextBlocks(lastMessage.content);
            if (messageContent) {
                return messageContent;
            }
        }
    }

    if ('output' in record) {
        return extractReplyTextFromEventData(record.output, depth + 1);
    }
    if (record.kwargs && 'output' in record.kwargs) {
        return extractReplyTextFromEventData(record.kwargs.output, depth + 1);
    }

    return '';
}

function getMessageRole(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const msg = message as {
        _getType?: unknown;
        type?: unknown;
        role?: unknown;
        kwargs?: { type?: unknown; role?: unknown };
    };

    if (typeof msg._getType === 'function') {
        try {
            const role = (msg._getType as () => string)();
            if (typeof role === 'string') {
                return role.toLowerCase();
            }
        } catch {
            // ignore
        }
    }

    if (typeof msg.type === 'string' && msg.type.trim()) {
        return msg.type.toLowerCase();
    }
    if (typeof msg.role === 'string' && msg.role.trim()) {
        return msg.role.toLowerCase();
    }
    if (msg.kwargs) {
        if (typeof msg.kwargs.type === 'string' && msg.kwargs.type.trim()) {
            return msg.kwargs.type.toLowerCase();
        }
        if (typeof msg.kwargs.role === 'string' && msg.kwargs.role.trim()) {
            return msg.kwargs.role.toLowerCase();
        }
    }
    return '';
}

export function isLikelyToolCallResidue(text: string): boolean {
    const cleaned = sanitizeUserFacingText(text);
    if (!cleaned) return true;
    if (TOOL_CALL_RESIDUE_PATTERN.test(cleaned)) return true;
    if (/(minimax:tool_call|tool_call)/i.test(cleaned)) return true;
    if (/^[\s\]\[}{(),.:;'"`\\/-]+$/.test(cleaned)) return true;

    const total = cleaned.length;
    const readable = (cleaned.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) || []).length;
    const braces = (cleaned.match(/[{}\[\]]/g) || []).length;
    if (total >= 40 && readable / total < 0.15 && braces / total > 0.3) {
        return true;
    }
    return false;
}

export function isLikelyStructuredToolPayload(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    const fenced = trimmed.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
    const body = (fenced?.[1] || trimmed).trim();
    if (!body) return false;
    if (!(body.startsWith('{') || body.startsWith('['))) {
        return false;
    }

    const compact = body.replace(/\s+/g, ' ');
    const kvLike = (compact.match(/":/g) || []).length;
    const objLike = (compact.match(/,\s*"/g) || []).length;
    const weatherLike = /(forecasts?|dayweather|nightweather|daytemp|nighttemp|temperature|humidity|wind|province|city|adcode)/i.test(compact);

    return kvLike >= 4 || objLike >= 4 || weatherLike;
}

export function extractBestReadableReplyFromMessages(messages: unknown[]): string {
    let fallback = '';

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || typeof message !== 'object') {
            continue;
        }

        const role = getMessageRole(message);
        const msg = message as { content?: unknown; kwargs?: { content?: unknown } };
        const content = extractTextBlocks(msg.content !== undefined ? msg.content : msg.kwargs?.content);
        const cleaned = sanitizeUserFacingText(content);
        if (!cleaned) {
            continue;
        }
        if (!fallback) {
            fallback = cleaned;
        }
        if ((role === 'ai' || role === 'assistant') && !isLikelyToolCallResidue(cleaned)) {
            return cleaned;
        }
    }

    if (fallback && !isLikelyToolCallResidue(fallback)) {
        return fallback;
    }
    return '';
}

export function pickBestUserFacingResponse(
    candidates: string[],
    options?: { sawToolCall?: boolean },
): string {
    const sawToolCall = options?.sawToolCall === true;
    let fallback = '';

    for (const candidate of candidates) {
        const cleaned = sanitizeUserFacingText(candidate);
        if (!cleaned) {
            continue;
        }
        if (isLikelyToolCallResidue(cleaned)) {
            continue;
        }
        if (!fallback) {
            fallback = cleaned;
        }
        if (sawToolCall && isLikelyStructuredToolPayload(cleaned)) {
            continue;
        }
        return cleaned;
    }

    return fallback;
}
