import crypto from 'node:crypto';
import type { ChatOpenAI } from '@langchain/openai';
import type { CompactionConfig } from '../compaction/index.js';
import { compactMessages, formatTokenCount, getContextUsageInfo } from '../compaction/index.js';

export interface CommandResult {
    handled: boolean;
    response?: string;
    action?: 'new_session' | 'compact' | 'info';
    newThreadId?: string;
    compactionResult?: {
        tokensBefore: number;
        tokensAfter: number;
        summary: string;
    };
}

export interface CommandContext {
    model: ChatOpenAI;
    config: CompactionConfig;
    currentTokens: number;
    threadId: string;
    sessionStartTime: Date;
}

/**
 * Parse slash command from user input
 */
export function parseCommand(input: string): { command: string; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
        return null;
    }

    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex === -1) {
        return { command: trimmed.toLowerCase(), args: '' };
    }

    return {
        command: trimmed.slice(0, spaceIndex).toLowerCase(),
        args: trimmed.slice(spaceIndex + 1).trim(),
    };
}

/**
 * Handle /new command - start a new session
 */
function handleNewCommand(): CommandResult {
    const newThreadId = `thread-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    return {
        handled: true,
        action: 'new_session',
        newThreadId,
        response: `🆕 新会话已创建。\n会话 ID: ${newThreadId.slice(0, 20)}...`,
    };
}

/**
 * Handle /compact command - compact context
 */
async function handleCompactCommand(
    args: string,
    context: CommandContext,
    messages: import('@langchain/core/messages').BaseMessage[],
): Promise<CommandResult> {
    const customInstructions = args || undefined;
    const maxTokens = Math.floor(context.config.context_window * context.config.max_history_share);

    try {
        const result = await compactMessages(
            messages,
            context.model,
            maxTokens,
            customInstructions,
        );

        const saved = result.tokensBefore - result.tokensAfter;
        const response = saved > 0
            ? `🧹 上下文压缩完成。\n` +
            `压缩前: ${formatTokenCount(result.tokensBefore)}\n` +
            `压缩后: ${formatTokenCount(result.tokensAfter)}\n` +
            `节省: ${formatTokenCount(saved)} tokens`
            : `ℹ️ 当前上下文较短，无需压缩。\n${getContextUsageInfo(result.tokensAfter, context.config)}`;

        return {
            handled: true,
            action: 'compact',
            response,
            compactionResult: {
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                summary: result.summary,
            },
        };
    } catch (error) {
        return {
            handled: true,
            action: 'compact',
            response: `❌ 压缩失败: ${error instanceof Error ? error.message : '未知错误'}`,
        };
    }
}

/**
 * Handle /status command - show current status
 */
function handleStatusCommand(context: CommandContext): CommandResult {
    const uptime = Math.floor((Date.now() - context.sessionStartTime.getTime()) / 1000);
    const uptimeStr = uptime >= 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : uptime >= 60
            ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
            : `${uptime}s`;

    const response = `📊 **会话状态**

${getContextUsageInfo(context.currentTokens, context.config)}
会话 ID: ${context.threadId.slice(0, 20)}...
运行时间: ${uptimeStr}
自动压缩阈值: ${formatTokenCount(context.config.auto_compact_threshold)}`;

    return {
        handled: true,
        action: 'info',
        response,
    };
}

/**
 * Handle /help command - show available commands
 */
function handleHelpCommand(): CommandResult {
    const response = `📖 **可用命令**

/new - 开始新会话（清空上下文）
/compact [说明] - 手动压缩上下文（可提供压缩重点说明）
/status - 显示当前会话状态
/help - 显示此帮助信息

**提示**: 当上下文过长时，系统会自动压缩。`;

    return {
        handled: true,
        action: 'info',
        response,
    };
}

/**
 * Handle a slash command
 */
export async function handleCommand(
    input: string,
    context: CommandContext,
    messages: import('@langchain/core/messages').BaseMessage[],
): Promise<CommandResult> {
    const parsed = parseCommand(input);

    if (!parsed) {
        return { handled: false };
    }

    switch (parsed.command) {
        case '/new':
        case '/reset':
            return handleNewCommand();

        case '/compact':
            return handleCompactCommand(parsed.args, context, messages);

        case '/status':
            return handleStatusCommand(context);

        case '/help':
        case '/?':
            return handleHelpCommand();

        default:
            return {
                handled: true,
                action: 'info',
                response: `❓ 未知命令: ${parsed.command}\n输入 /help 查看可用命令。`,
            };
    }
}
