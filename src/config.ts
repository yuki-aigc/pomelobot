import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface OpenAIConfig {
    base_url: string;
    model: string;
    api_key: string;
    max_retries?: number;
}

export interface CompactionConfig {
    enabled: boolean;
    auto_compact_threshold: number;
    context_window: number;
    reserve_tokens: number;
    max_history_share: number;
}

export interface AgentConfig {
    workspace: string;
    skills_dir: string;
    recursion_limit: number;
    compaction: CompactionConfig;
}

export interface ExecCommandsFile {
    allowedCommands: string[];
    deniedCommands: string[];
}

export interface ExecApprovalsConfig {
    enabled: boolean;
}

export interface ExecConfigFile {
    enabled: boolean;
    commandsFile?: string;
    allowedCommands?: string[];
    deniedCommands?: string[];
    defaultTimeoutMs: number;
    maxOutputLength: number;
    approvals?: Partial<ExecApprovalsConfig>;
}

export interface ExecConfig {
    enabled: boolean;
    allowedCommands: string[];
    deniedCommands: string[];
    defaultTimeoutMs: number;
    maxOutputLength: number;
    approvals: ExecApprovalsConfig;
}

export interface DingTalkConfig {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    messageType?: 'markdown' | 'card';
    cardTemplateId?: string;
    showThinking?: boolean;
    debug?: boolean;
    execApprovals?: {
        enabled?: boolean;
        timeoutMs?: number;
        mode?: 'text' | 'button';
        templateId?: string;
    };
}

export interface Config {
    openai: OpenAIConfig;
    agent: AgentConfig;
    exec: ExecConfig;
    dingtalk?: DingTalkConfig;
}

const DEFAULT_COMMANDS: ExecCommandsFile = {
    allowedCommands: [
        'ls', 'cat', 'head', 'tail', 'grep', 'find', 'pwd', 'echo',
        'date', 'whoami', 'df', 'uptime', 'ps',
    ],
    deniedCommands: ['rm', 'mv', 'cp', 'chmod', 'chown', 'sudo', 'su'],
};

const DEFAULT_CONFIG = {
    openai: {
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        api_key: '',
        max_retries: 3,
    },
    agent: {
        workspace: './workspace',
        skills_dir: './workspace/skills',
        recursion_limit: 100,
        compaction: {
            enabled: true,
            auto_compact_threshold: 80000,
            context_window: 128000,
            reserve_tokens: 20000,
            max_history_share: 0.5,
        },
    },
    exec: {
        enabled: true,
        defaultTimeoutMs: 30000,
        maxOutputLength: 50000,
        approvals: {
            enabled: false,
        },
    },
};

/**
 * Load exec commands from a separate file or use inline config
 */
function loadExecCommands(execConfig: ExecConfigFile): ExecCommandsFile {
    if (execConfig.commandsFile) {
        const commandsPath = resolve(process.cwd(), execConfig.commandsFile);
        if (existsSync(commandsPath)) {
            try {
                const content = readFileSync(commandsPath, 'utf-8');
                const commands = JSON.parse(content) as ExecCommandsFile;
                console.log(`[Config] Loaded exec commands from ${execConfig.commandsFile}`);
                return {
                    allowedCommands: commands.allowedCommands || DEFAULT_COMMANDS.allowedCommands,
                    deniedCommands: commands.deniedCommands || DEFAULT_COMMANDS.deniedCommands,
                };
            } catch (error) {
                console.warn(`Warning: Failed to parse ${execConfig.commandsFile}, using defaults`);
            }
        } else {
            console.warn(`Warning: Commands file ${execConfig.commandsFile} not found, using defaults`);
        }
    }

    return {
        allowedCommands: execConfig.allowedCommands || DEFAULT_COMMANDS.allowedCommands,
        deniedCommands: execConfig.deniedCommands || DEFAULT_COMMANDS.deniedCommands,
    };
}

export function loadConfig(): Config {
    const configPath = join(process.cwd(), 'config.json');

    let fileConfig: {
        openai?: Partial<OpenAIConfig>;
        agent?: Partial<AgentConfig> & { compaction?: Partial<CompactionConfig> };
        exec?: ExecConfigFile;
        dingtalk?: DingTalkConfig;
    } = {};

    if (existsSync(configPath)) {
        try {
            const content = readFileSync(configPath, 'utf-8');
            fileConfig = JSON.parse(content);
        } catch (error) {
            console.warn('Warning: Failed to parse config.json, using defaults');
        }
    }

    const execCommands = loadExecCommands(fileConfig.exec || { enabled: true, defaultTimeoutMs: 30000, maxOutputLength: 50000 });

    const config: Config = {
        openai: {
            ...DEFAULT_CONFIG.openai,
            ...fileConfig.openai,
        },
        agent: {
            ...DEFAULT_CONFIG.agent,
            ...fileConfig.agent,
            compaction: {
                ...DEFAULT_CONFIG.agent.compaction,
                ...(fileConfig.agent?.compaction || {}),
            },
        },
        exec: {
            enabled: fileConfig.exec?.enabled ?? DEFAULT_CONFIG.exec.enabled,
            allowedCommands: execCommands.allowedCommands,
            deniedCommands: execCommands.deniedCommands,
            defaultTimeoutMs: fileConfig.exec?.defaultTimeoutMs ?? DEFAULT_CONFIG.exec.defaultTimeoutMs,
            maxOutputLength: fileConfig.exec?.maxOutputLength ?? DEFAULT_CONFIG.exec.maxOutputLength,
            approvals: {
                enabled: fileConfig.exec?.approvals?.enabled ?? DEFAULT_CONFIG.exec.approvals.enabled,
            },
        },
        dingtalk: fileConfig.dingtalk,
    };

    if (process.env.OPENAI_BASE_URL) {
        config.openai.base_url = process.env.OPENAI_BASE_URL;
    }
    if (process.env.OPENAI_MODEL) {
        config.openai.model = process.env.OPENAI_MODEL;
    }
    if (process.env.OPENAI_API_KEY) {
        config.openai.api_key = process.env.OPENAI_API_KEY;
    }

    if (!config.openai.api_key) {
        console.error('Error: OpenAI API key is required. Set it in config.json or OPENAI_API_KEY environment variable.');
        process.exit(1);
    }

    return config;
}
