import type { ExecConfig } from '../config.js';
import { parseCommandInput } from './command-parser.js';

export interface PolicyCheckResult {
    allowed: boolean;
    reason?: string;
}

export type PolicyStatus = 'allowed' | 'denied' | 'unknown' | 'disabled';
export type CommandRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CommandRiskAssessment {
    level: CommandRiskLevel;
    blocked: boolean;
    requiresApproval: boolean;
    reasons: string[];
}

export interface PolicyCheckDetail {
    status: PolicyStatus;
    baseCommand: string | null;
    reason?: string;
    risk: CommandRiskAssessment;
    parsedTokens: string[];
    parseError?: string;
    requiresApproval: boolean;
}

/**
 * Extract the base command from a command token
 * e.g., "/usr/bin/ls" -> "ls"
 */
function extractBaseCommand(commandToken: string): string {
    const parts = commandToken.split('/');
    return parts[parts.length - 1];
}

function buildRiskAssessment(
    level: CommandRiskLevel,
    reasons: string[] = [],
    options: { blocked?: boolean; requiresApproval?: boolean } = {}
): CommandRiskAssessment {
    return {
        level,
        blocked: options.blocked ?? false,
        requiresApproval: options.requiresApproval ?? false,
        reasons,
    };
}

const BLOCKED_OPERATOR_TOKENS = new Set(['|', '||', '&', '&&', ';', '>', '>>', '<', '<<']);

/**
 * Assess command string risk before execution.
 * shell=false execution is enforced, so this focuses on dangerous/suspicious input patterns.
 */
export function assessCommandRisk(command: string): CommandRiskAssessment {
    if (command.length > 4096) {
        return buildRiskAssessment('critical', ['Command length exceeds 4096 characters'], { blocked: true });
    }
    if (/[\0\r\n]/.test(command)) {
        return buildRiskAssessment('critical', ['Control characters are not allowed in command input'], { blocked: true });
    }

    const parsed = parseCommandInput(command);
    if (!parsed.ok || !parsed.parsed) {
        return buildRiskAssessment('high', [parsed.error || 'Failed to parse command'], { blocked: true });
    }

    const reasons: string[] = [];
    let level: CommandRiskLevel = 'low';
    let blocked = false;
    let requiresApproval = false;

    for (const token of parsed.parsed.tokens) {
        if (BLOCKED_OPERATOR_TOKENS.has(token)) {
            reasons.push(`Shell control operator "${token}" is not supported`);
            blocked = true;
            level = 'high';
        }
        if (token.includes(';')) {
            reasons.push('Semicolon chaining is not allowed');
            blocked = true;
            level = 'high';
        }
        if (token.includes('>') || token.includes('<')) {
            reasons.push('Redirection operators are not allowed');
            blocked = true;
            level = 'high';
        }
        if (token.includes('`')) {
            reasons.push('Backtick command substitution is not allowed');
            blocked = true;
            level = 'high';
        }
        if (token.includes('$(') || token.includes('${')) {
            reasons.push('Command substitution-like token detected');
            requiresApproval = true;
            if (level === 'low') level = 'medium';
        }
    }

    const normalized = parsed.parsed.tokens.join(' ');
    if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i.test(normalized)) {
        reasons.push('Pipe-to-shell pattern detected');
        blocked = true;
        level = 'critical';
    }

    return buildRiskAssessment(level, reasons, { blocked, requiresApproval });
}

/**
 * Check command policy and return a detailed status.
 */
export function checkCommandPolicy(command: string, config: ExecConfig): PolicyCheckDetail {
    const risk = assessCommandRisk(command);

    if (!config.enabled) {
        return {
            status: 'disabled',
            baseCommand: null,
            reason: 'Exec tool is disabled in configuration',
            risk,
            parsedTokens: [],
            requiresApproval: false,
        };
    }

    if (risk.blocked) {
        return {
            status: 'denied',
            baseCommand: null,
            reason: `Blocked by command safety policy: ${risk.reasons.join('; ') || 'High-risk input'}`,
            risk,
            parsedTokens: [],
            requiresApproval: false,
        };
    }

    const parsed = parseCommandInput(command);
    if (!parsed.ok || !parsed.parsed) {
        return {
            status: 'denied',
            baseCommand: null,
            reason: parsed.error || 'Empty or invalid command',
            risk,
            parsedTokens: [],
            parseError: parsed.error,
            requiresApproval: false,
        };
    }

    const baseCommand = extractBaseCommand(parsed.parsed.command);
    if (!baseCommand) {
        return {
            status: 'denied',
            baseCommand: null,
            reason: 'Empty or invalid command',
            risk,
            parsedTokens: parsed.parsed.tokens,
            requiresApproval: false,
        };
    }

    if (config.deniedCommands.includes(baseCommand)) {
        return {
            status: 'denied',
            baseCommand,
            reason: `Command '${baseCommand}' is in the denied list`,
            risk,
            parsedTokens: parsed.parsed.tokens,
            requiresApproval: false,
        };
    }

    if (config.allowedCommands.includes(baseCommand)) {
        return {
            status: 'allowed',
            baseCommand,
            risk,
            parsedTokens: parsed.parsed.tokens,
            requiresApproval: risk.requiresApproval,
        };
    }

    return {
        status: 'unknown',
        baseCommand,
        reason: `Command '${baseCommand}' is not in the allowed list. Allowed commands: ${config.allowedCommands.join(', ')}`,
        risk,
        parsedTokens: parsed.parsed.tokens,
        requiresApproval: true,
    };
}

/**
 * Check if a command is allowed based on the exec configuration
 * 
 * Rules:
 * 1. If the command is in deniedCommands, it's always denied (highest priority)
 * 2. If the command is in allowedCommands, it's allowed
 * 3. If the command is not in either list, it's denied by default
 */
export function isCommandAllowed(command: string, config: ExecConfig): PolicyCheckResult {
    const detail = checkCommandPolicy(command, config);
    return {
        allowed: detail.status === 'allowed',
        reason: detail.status === 'allowed' ? undefined : detail.reason,
    };
}

/**
 * Create a policy checker bound to a specific config
 */
export function createPolicyChecker(config: ExecConfig) {
    return {
        isAllowed: (command: string) => isCommandAllowed(command, config),
        getAllowedCommands: () => [...config.allowedCommands],
        getDeniedCommands: () => [...config.deniedCommands],
    };
}
