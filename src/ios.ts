import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgent } from './agent.js';
import { loadConfig } from './config.js';
import { getActiveModelName } from './llm.js';
import { createIOSChannelAdapter } from './channels/ios/index.js';
import type { IOSLogger } from './channels/ios/index.js';
import { GatewayService } from './channels/gateway/index.js';
import { CronService } from './cron/service.js';
import { getCronService, setCronService } from './cron/runtime.js';
import { resolveCronStorePath } from './cron/store.js';
import type { CronJob } from './cron/types.js';
import type { RuntimeLogWriter } from './log/runtime.js';
import { buildPromptBootstrapMessage } from './prompt/bootstrap.js';
import { resolveMemoryScope } from './middleware/memory-scope.js';

const colors = {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    orange: '\x1b[38;5;208m',
    bright: '\x1b[1m',
};

function createLogger(debug = false, logWriter?: RuntimeLogWriter): IOSLogger {
    return {
        debug: (message: string, ...args: unknown[]) => {
            logWriter?.write('DEBUG', message, args);
            if (debug) {
                console.log(`${colors.gray}${message}${colors.reset}`, ...args);
            }
        },
        info: (message: string, ...args: unknown[]) => {
            logWriter?.write('INFO', message, args);
            console.log(`${colors.cyan}${message}${colors.reset}`, ...args);
        },
        warn: (message: string, ...args: unknown[]) => {
            logWriter?.write('WARN', message, args);
            console.warn(`${colors.yellow}${message}${colors.reset}`, ...args);
        },
        error: (message: string, ...args: unknown[]) => {
            logWriter?.write('ERROR', message, args);
            console.error(`${colors.red}${message}${colors.reset}`, ...args);
        },
    };
}

function printHeader(config: ReturnType<typeof loadConfig>) {
    const model = getActiveModelName(config);

    const o = colors.orange;
    const r = colors.reset;
    const g = colors.gray;
    const b = colors.bright;
    const c = colors.cyan;

    console.log();
    console.log(`     ${o}▄▄▄▄▄${r}        ${b}SRE Bot${r} ${g}v1.0.0${r} ${c}[iOS Mode]${r}`);
    console.log(`   ${o}█${r} ●   ● ${o}█${r}      ${g}${model}${r}`);
    console.log(`   ${o}█${r}       ${o}█${r}      ${g}WebSocket Gateway Enabled${r}`);
    console.log(`    ${o}▀▀▀▀▀▀▀${r}`);
    console.log();
}

function extractTextContent(content: unknown): string {
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

function extractAgentResponseText(result: unknown): string {
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

function buildCronDeliveryTarget(job: CronJob, config: ReturnType<typeof loadConfig>): string | undefined {
    const fromJob = job.delivery.target?.trim();
    if (fromJob) return fromJob;
    const fromConfig = config.ios?.cron?.defaultTarget?.trim();
    if (fromConfig) return fromConfig;
    return undefined;
}

function resolveIOSCronStorePath(config: ReturnType<typeof loadConfig>): string {
    const fromConfig = config.ios?.cron?.store?.trim();
    if (fromConfig) {
        return resolveCronStorePath(fromConfig);
    }
    return resolveCronStorePath('./workspace/cron/ios-jobs.json');
}

function resolveIOSCronRunLogPath(config: ReturnType<typeof loadConfig>): string {
    return config.ios?.cron?.runLog?.trim() || './workspace/cron/ios-runs.jsonl';
}

export async function startIOSService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();

    if (!config.ios) {
        throw new Error('iOS configuration not found in config.json');
    }
    if (!config.ios.enabled) {
        throw new Error('iOS channel is disabled (config.ios.enabled=false)');
    }

    const iosConfig = config.ios;
    const log = createLogger(iosConfig.debug, options?.logWriter);

    printHeader(config);

    log.info('[iOS] Initializing agent...');
    const initialAgentContext = await createAgent(config, {
        runtimeChannel: 'ios',
    });

    let currentAgent = initialAgentContext.agent;
    let cleanup = initialAgentContext.cleanup;
    let gateway: GatewayService | null = null;
    let cronService: CronService | null = null;
    const bootstrappedThreads = new Set<string>();
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);

    gateway = new GatewayService({
        onProcessInbound: async (message) => {
            if (message.channel !== 'ios') {
                return { skipReply: true };
            }

            const userText = message.text.trim();
            if (!userText) {
                return {
                    reply: {
                        text: '收到空消息，无法处理。',
                    },
                };
            }

            const threadId = `ios-${message.conversationId}`;
            const scope = resolveMemoryScope(config.agent.memory.session_isolation);
            const invocationMessages: Array<{ role: 'user'; content: string }> = [];
            if (!bootstrappedThreads.has(threadId)) {
                const bootstrapPromptMessage = await buildPromptBootstrapMessage({
                    workspacePath: memoryWorkspacePath,
                    scopeKey: scope.key,
                });
                if (bootstrapPromptMessage) {
                    invocationMessages.push(bootstrapPromptMessage);
                }
                bootstrappedThreads.add(threadId);
            }
            invocationMessages.push({
                role: 'user',
                content: userText,
            });
            const invokeResult = await currentAgent.invoke(
                {
                    messages: invocationMessages,
                },
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: config.agent.recursion_limit,
                }
            );

            const replyText = extractAgentResponseText(invokeResult) || '已处理，但没有可返回的文本结果。';
            return {
                reply: {
                    text: replyText,
                    useMarkdown: false,
                },
            };
        },
        logger: {
            debug: (message: string, ...args: unknown[]) => log.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => log.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => log.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => log.error(message, ...args),
        },
    });

    const iosAdapter = createIOSChannelAdapter({ config: iosConfig, log });
    gateway.registerAdapter(iosAdapter);
    await gateway.start();

    cronService = new CronService({
        enabled: config.cron.enabled,
        timezone: config.cron.timezone,
        storePath: resolveIOSCronStorePath(config),
        runLogPath: resolveIOSCronRunLogPath(config),
        defaultDelivery: {
            channel: 'ios',
            target: iosConfig.cron?.defaultTarget,
            useMarkdown: iosConfig.cron?.useMarkdown,
            title: iosConfig.cron?.title,
        },
        logger: {
            debug: (message: string, ...args: unknown[]) => log.debug(message, ...args),
            info: (message: string, ...args: unknown[]) => log.info(message, ...args),
            warn: (message: string, ...args: unknown[]) => log.warn(message, ...args),
            error: (message: string, ...args: unknown[]) => log.error(message, ...args),
        },
        runJob: async (job) => {
            const deliveryChannel = job.delivery.channel?.trim().toLowerCase() || 'ios';
            if (deliveryChannel !== 'ios') {
                return {
                    status: 'skipped',
                    error: `任务 ${job.id} 配置 channel=${deliveryChannel}，当前实例仅处理 ios`,
                };
            }

            const target = buildCronDeliveryTarget(job, config);
            if (!target) {
                return {
                    status: 'error',
                    error: `任务 ${job.id} 未配置发送目标；请设置 cron_job_add.target 或 config.ios.cron.defaultTarget`,
                };
            }

            const threadId = `cron-ios-${job.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const cronMessages: Array<{ role: 'user'; content: string }> = [];
            const bootstrapPromptMessage = await buildPromptBootstrapMessage({
                workspacePath: memoryWorkspacePath,
                scopeKey: 'main',
            });
            if (bootstrapPromptMessage) {
                cronMessages.push(bootstrapPromptMessage);
            }
            cronMessages.push({
                role: 'user',
                content: `[定时任务 ${job.name}] ${job.payload.message}`,
            });
            const invokeResult = await currentAgent.invoke(
                {
                    messages: cronMessages,
                },
                {
                    configurable: { thread_id: threadId },
                    recursionLimit: config.agent.recursion_limit,
                }
            );

            const text = extractAgentResponseText(invokeResult) || '任务已执行，但未返回文本结果。';
            const useMarkdown = job.delivery.useMarkdown ?? iosConfig.cron?.useMarkdown ?? false;
            const title = job.delivery.title || iosConfig.cron?.title || `定时任务: ${job.name}`;
            const outboundText = useMarkdown
                ? `## ${job.name}\n\n${text}`
                : `【${job.name}】\n${text}`;

            await gateway.sendProactive({
                channel: 'ios',
                target,
                message: {
                    text: outboundText,
                    title,
                    useMarkdown,
                },
            });

            return {
                status: 'ok',
                summary: text.slice(0, 300),
            };
        },
    });

    await cronService.start();
    setCronService('ios', cronService);
    if (!getCronService()) {
        setCronService(cronService);
    }

    log.info('[iOS] Service started and ready for websocket clients.');
    console.log();
    console.log(`${colors.gray}Press Ctrl+C to stop iOS service.${colors.reset}`);
    console.log();

    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.info('[iOS] Shutting down...');

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[iOS] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cronService) {
            try {
                await cronService.stop();
            } catch (error) {
                log.warn('[iOS] cron service stop failed:', error instanceof Error ? error.message : String(error));
            }
            setCronService('ios', null);
        }

        if (cleanup) {
            try {
                await cleanup();
            } catch (error) {
                log.warn('[iOS] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (exitOnShutdown) {
            process.exit(0);
        }
    };

    if (registerSignalHandlers) {
        process.on('SIGINT', () => {
            void shutdown();
        });
        process.on('SIGTERM', () => {
            void shutdown();
        });
    }

    return { shutdown };
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
    startIOSService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
