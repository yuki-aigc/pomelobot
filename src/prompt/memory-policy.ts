import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface StartupMemoryInjectionLimits {
    maxFiles: number;
    maxLinesPerFile: number;
    maxFileChars: number;
    maxTotalChars: number;
}

export const DEFAULT_STARTUP_MEMORY_INJECTION_LIMITS: StartupMemoryInjectionLimits = {
    maxFiles: 2,
    maxLinesPerFile: 80,
    maxFileChars: 1200,
    maxTotalChars: 2400,
};

function formatLocalDateWithOffset(baseDate: Date, offsetDays: number): string {
    const date = new Date(baseDate.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function resolveScopedDailyMemoryPath(workspacePath: string, scopeKey: string, dateKey: string): string {
    return join(workspacePath, 'memory', 'scopes', scopeKey, `${dateKey}.md`);
}

function compactStartupMemoryText(content: string, maxLinesPerFile: number, maxFileChars: number): string {
    const lines = content
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    const tail = lines.slice(-maxLinesPerFile);
    const merged = tail.join('\n').trim();
    if (merged.length <= maxFileChars) {
        return merged;
    }
    return `${merged.slice(0, Math.max(0, maxFileChars - 1))}…`;
}

function trimInjectionByTotalChars(blocks: string[], maxChars: number): string[] {
    if (maxChars <= 0) {
        return [];
    }
    const output: string[] = [];
    let used = 0;
    for (const block of blocks) {
        if (!block) {
            continue;
        }
        const remaining = maxChars - used;
        if (remaining <= 0) {
            break;
        }
        if (block.length <= remaining) {
            output.push(block);
            used += block.length;
            continue;
        }
        if (remaining >= 20) {
            output.push(`${block.slice(0, Math.max(0, remaining - 1))}…`);
            used = maxChars;
        }
        break;
    }
    return output;
}

export async function buildSessionStartupMemoryInjection(params: {
    workspacePath: string;
    scopeKey: string;
    now?: Date;
    limits?: Partial<StartupMemoryInjectionLimits>;
}): Promise<string | null> {
    const now = params.now ?? new Date();
    const limits: StartupMemoryInjectionLimits = {
        ...DEFAULT_STARTUP_MEMORY_INJECTION_LIMITS,
        ...(params.limits || {}),
    };
    const dateKeys = [
        formatLocalDateWithOffset(now, 0),
        formatLocalDateWithOffset(now, -1),
    ];
    const snippets: string[] = [];

    for (const dateKey of dateKeys.slice(0, limits.maxFiles)) {
        const absPath = resolveScopedDailyMemoryPath(params.workspacePath, params.scopeKey, dateKey);
        let raw = '';
        try {
            raw = await readFile(absPath, 'utf-8');
        } catch {
            continue;
        }
        const compact = compactStartupMemoryText(raw, limits.maxLinesPerFile, limits.maxFileChars);
        if (!compact || compact.length < 20) {
            continue;
        }
        const relPath = relative(params.workspacePath, absPath).replace(/\\/g, '/');
        snippets.push(`### ${dateKey} (${relPath})\n${compact}`);
    }

    if (snippets.length === 0) {
        return null;
    }

    const header = [
        '【会话启动记忆注入（今昨摘要）】',
        '以下内容来自 Markdown 记忆文件（非向量库），仅作首轮上下文补充。',
        '若用户追问历史细节，仍应调用 memory_search / memory_get 取证。',
        '',
    ].join('\n');
    const bodyBlocks = trimInjectionByTotalChars(snippets, Math.max(0, limits.maxTotalChars - header.length));
    if (bodyBlocks.length === 0) {
        return null;
    }
    return `${header}${bodyBlocks.join('\n\n')}`;
}

export function hasMemoryRecallIntent(text: string): boolean {
    return /(你还记得|还记得吗|之前|上次|昨天|昨日|前天|刚才|刚刚|问过|聊过|历史|回顾|回溯|做过什么|提过什么)/u.test(text);
}

export function buildMemorySearchEnforcedPrompt(userText: string): string {
    return [
        '【记忆检索强制规则】',
        '当前问题属于历史回溯类问题。',
        '你必须先调用 memory_search 检索，再基于检索结果回答。',
        '若需要精确引用，再调用 memory_get 读取命中片段。',
        '如果检索不到，请明确说明“已检索但未找到足够信息”，禁止直接凭空回答。',
        '',
        `用户原问题：${userText}`,
    ].join('\n');
}

export function buildUserMessagesWithMemoryPolicy(
    userText: string,
    options?: { enforceMemorySearch?: boolean; startupMemoryInjection?: string | null },
): Array<{ role: 'user'; content: string }> {
    const messages: Array<{ role: 'user'; content: string }> = [];
    if (options?.startupMemoryInjection) {
        messages.push({
            role: 'user',
            content: [
                '【会话启动上下文】',
                options.startupMemoryInjection,
                '',
                '以上是会话启动补充信息，请结合当前问题作答。',
            ].join('\n'),
        });
    }
    if (options?.enforceMemorySearch) {
        messages.push({ role: 'user', content: buildMemorySearchEnforcedPrompt(userText) });
        return messages;
    }
    messages.push({ role: 'user', content: userText });
    return messages;
}
