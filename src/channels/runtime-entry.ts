import type { Config } from '../config.js';
import { getActiveModelName } from '../llm.js';
import type { RuntimeLogWriter } from '../log/runtime.js';
import type { GatewayLogger } from './gateway/types.js';

export const terminalColors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    orange: '\x1b[38;5;208m',
    black: '\x1b[30m',
    magenta: '\x1b[35m',
};

export interface RuntimeConsoleLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export function createRuntimeConsoleLogger(options?: {
    debug?: boolean;
    logWriter?: RuntimeLogWriter;
}): RuntimeConsoleLogger {
    const debugEnabled = options?.debug ?? false;
    const logWriter = options?.logWriter;

    return {
        debug: (message: string, ...args: unknown[]) => {
            logWriter?.write('DEBUG', message, args);
            if (debugEnabled) {
                console.log(`${terminalColors.gray}${message}${terminalColors.reset}`, ...args);
            }
        },
        info: (message: string, ...args: unknown[]) => {
            logWriter?.write('INFO', message, args);
            console.log(`${terminalColors.cyan}${message}${terminalColors.reset}`, ...args);
        },
        warn: (message: string, ...args: unknown[]) => {
            logWriter?.write('WARN', message, args);
            console.warn(`${terminalColors.yellow}${message}${terminalColors.reset}`, ...args);
        },
        error: (message: string, ...args: unknown[]) => {
            logWriter?.write('ERROR', message, args);
            console.error(`${terminalColors.red}${message}${terminalColors.reset}`, ...args);
        },
    };
}

export function toGatewayLogger(logger: RuntimeConsoleLogger): Partial<GatewayLogger> {
    return {
        debug: (message: string, ...args: unknown[]) => logger.debug(message, ...args),
        info: (message: string, ...args: unknown[]) => logger.info(message, ...args),
        warn: (message: string, ...args: unknown[]) => logger.warn(message, ...args),
        error: (message: string, ...args: unknown[]) => logger.error(message, ...args),
    };
}

export function printChannelHeader(options: {
    config: Config;
    modeLabel: string;
    statusLines: string[];
}): void {
    const model = getActiveModelName(options.config);
    const o = terminalColors.orange;
    const r = terminalColors.reset;
    const g = terminalColors.gray;
    const b = terminalColors.bright;
    const c = terminalColors.cyan;

    console.log();
    console.log(`     ${o}▄▄▄▄▄${r}        ${b}SRE Bot${r} ${g}v1.0.0${r} ${c}[${options.modeLabel}]${r}`);
    console.log(`   ${o}█${r} ●   ● ${o}█${r}      ${g}${model}${r}`);
    for (const line of options.statusLines) {
        console.log(`   ${o}█${r}       ${o}█${r}      ${g}${line}${r}`);
    }
    console.log(`    ${o}▀▀▀▀▀▀▀${r}`);
    console.log();
}

export function extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }
    const blocks: string[] = [];
    for (const block of content) {
        if (typeof block === 'string') {
            blocks.push(block);
            continue;
        }
        if (!block || typeof block !== 'object') {
            continue;
        }
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
            blocks.push(text);
        }
    }
    return blocks.join('\n').trim();
}

export function extractAgentResponseText(result: unknown): string {
    if (!result || typeof result !== 'object') {
        return '';
    }
    const messages = (result as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }
    const lastMessage = messages[messages.length - 1] as { content?: unknown } | undefined;
    if (!lastMessage) {
        return '';
    }
    return extractTextContent(lastMessage.content);
}
