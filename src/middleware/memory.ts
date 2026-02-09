/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryMiddlewareOptions {
    workspacePath: string;
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate(): string {
    return formatLocalDate(new Date());
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 */
function getYesterdayDate(): string {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    return formatLocalDate(now);
}

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Load memory context for system prompt injection
 */
export function loadMemoryContext(workspacePath: string): string {
    const memoryDir = join(workspacePath, 'memory');
    const longTermPath = join(workspacePath, 'MEMORY.md');

    let context = '';

    // Load long-term memory
    if (existsSync(longTermPath)) {
        const content = readFileSync(longTermPath, 'utf-8').trim();
        if (content && content !== '# Long-term Memory\n\nImportant information that persists across sessions.\n\n---') {
            context += `### 长期记忆\n${content}\n\n`;
        }
    }

    // Load today's memory
    const todayPath = join(memoryDir, `${getTodayDate()}.md`);
    if (existsSync(todayPath)) {
        const content = readFileSync(todayPath, 'utf-8').trim();
        if (content) {
            context += `### 今日记忆 (${getTodayDate()})\n${content}\n\n`;
        }
    }

    // Load yesterday's memory
    const yesterdayPath = join(memoryDir, `${getYesterdayDate()}.md`);
    if (existsSync(yesterdayPath)) {
        const content = readFileSync(yesterdayPath, 'utf-8').trim();
        if (content) {
            context += `### 昨日记忆 (${getYesterdayDate()})\n${content}\n\n`;
        }
    }

    return context || '暂无记忆内容。';
}

/**
 * Create memory-specific tools
 */
export function createMemoryTools(workspacePath: string) {
    const memoryDir = join(workspacePath, 'memory');
    const longTermPath = join(workspacePath, 'MEMORY.md');

    // Ensure memory directory exists
    if (!existsSync(memoryDir)) {
        mkdirSync(memoryDir, { recursive: true });
    }

    const memorySave = tool(
        async ({ content, target }: { content: string; target: 'daily' | 'long-term' }) => {
            const timestamp = new Date().toLocaleTimeString('zh-CN');
            const entry = `\n[${timestamp}] ${content}\n`;

            if (target === 'daily') {
                const dailyPath = join(memoryDir, `${getTodayDate()}.md`);
                let existing = '';
                if (existsSync(dailyPath)) {
                    existing = readFileSync(dailyPath, 'utf-8');
                } else {
                    existing = `# Daily Memory - ${getTodayDate()}\n`;
                }
                writeFileSync(dailyPath, existing + entry, 'utf-8');
                return `已保存到每日记忆: ${dailyPath}`;
            } else {
                let existing = '';
                if (existsSync(longTermPath)) {
                    existing = readFileSync(longTermPath, 'utf-8');
                } else {
                    existing = '# Long-term Memory\n\n';
                }
                writeFileSync(longTermPath, existing + entry, 'utf-8');
                return `已保存到长期记忆: ${longTermPath}`;
            }
        },
        {
            name: 'memory_save',
            description: '保存重要信息到记忆系统。使用 "daily" 存储今日笔记，使用 "long-term" 存储重要的持久性信息。',
            schema: z.object({
                content: z.string().describe('要保存的记忆内容'),
                target: z.enum(['daily', 'long-term']).describe('目标: daily(每日记忆) 或 long-term(长期记忆)'),
            }),
        }
    );

    const memorySearch = tool(
        async ({ query }: { query: string }) => {
            const results: string[] = [];

            // Search long-term memory
            if (existsSync(longTermPath)) {
                const content = readFileSync(longTermPath, 'utf-8');
                const lines = content.split('\n');
                lines.forEach((line: string, index: number) => {
                    if (line.toLowerCase().includes(query.toLowerCase())) {
                        results.push(`[长期记忆:${index + 1}] ${line}`);
                    }
                });
            }

            // Search daily memories
            if (existsSync(memoryDir)) {
                const files = readdirSync(memoryDir).filter((f: string) => f.endsWith('.md'));
                for (const file of files) {
                    const filePath = join(memoryDir, file);
                    const content = readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    lines.forEach((line: string, index: number) => {
                        if (line.toLowerCase().includes(query.toLowerCase())) {
                            results.push(`[${file}:${index + 1}] ${line}`);
                        }
                    });
                }
            }

            return results.length > 0
                ? `找到 ${results.length} 条相关记忆:\n${results.slice(0, 20).join('\n')}`
                : `未找到与 "${query}" 相关的记忆`;
        },
        {
            name: 'memory_search',
            description: '在所有记忆文件中搜索关键词',
            schema: z.object({
                query: z.string().describe('搜索关键词'),
            }),
        }
    );

    return [memorySave, memorySearch];
}
