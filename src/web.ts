import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgent } from './agent.js';
import { loadConfig } from './config.js';
import { createWebChannelAdapter, type WebLogger, type WebChannelAdapter } from './channels/web/index.js';
import { GatewayService } from './channels/gateway/index.js';
import { buildPromptBootstrapMessage } from './prompt/bootstrap.js';
import { resolveMemoryScope } from './middleware/memory-scope.js';
import { consumeQueuedWebReplyFiles } from './channels/web/context.js';
import {
    createRuntimeConsoleLogger,
    printChannelHeader,
    terminalColors as colors,
    toGatewayLogger,
} from './channels/runtime-entry.js';
import {
    extractBestReadableReplyFromMessages,
    extractReplyTextFromEventData,
    extractStreamChunkText,
    isLikelyStructuredToolPayload,
    isLikelyToolCallResidue,
    pickBestUserFacingResponse,
    sanitizeUserFacingText,
} from './channels/streaming.js';
import type { RuntimeLogWriter } from './log/runtime.js';

const conversationQueue = new Map<string, Promise<void>>();

function enqueueConversationTask(
    conversationId: string,
    task: () => Promise<void>,
): Promise<void> {
    const previous = conversationQueue.get(conversationId) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
        if (conversationQueue.get(conversationId) === next) {
            conversationQueue.delete(conversationId);
        }
    });
    conversationQueue.set(conversationId, next);
    return next;
}

export async function startWebService(options?: {
    registerSignalHandlers?: boolean;
    exitOnShutdown?: boolean;
    logWriter?: RuntimeLogWriter;
}): Promise<{ shutdown: () => Promise<void> }> {
    const registerSignalHandlers = options?.registerSignalHandlers ?? false;
    const exitOnShutdown = options?.exitOnShutdown ?? false;
    const config = loadConfig();

    if (!config.web) {
        throw new Error('Web configuration not found in config.json');
    }
    if (!config.web.enabled) {
        throw new Error('Web channel is disabled (config.web.enabled=false)');
    }

    const webConfig = config.web;
    const log: WebLogger = createRuntimeConsoleLogger({
        debug: webConfig.debug,
        logWriter: options?.logWriter,
    });

    printChannelHeader({
        config,
        modeLabel: 'Web Mode',
        statusLines: ['Streaming WebSocket + Built-in UI'],
    });

    log.info('[Web] Initializing agent...');
    const initialAgentContext = await createAgent(config, {
        runtimeChannel: 'web',
    });

    let currentAgent = initialAgentContext.agent;
    let cleanup = initialAgentContext.cleanup;
    let gateway: GatewayService | null = null;
    let webAdapter: WebChannelAdapter | null = null;
    let isShuttingDown = false;
    const bootstrappedThreads = new Set<string>();
    const memoryWorkspacePath = resolve(process.cwd(), config.agent.workspace);

    gateway = new GatewayService({
        onProcessInbound: async (message) => {
            if (message.channel !== 'web') {
                return { skipReply: true };
            }
            const adapter = webAdapter;
            if (!adapter) {
                throw new Error('Web adapter is not ready');
            }

            await enqueueConversationTask(message.conversationId, async () => {
                const userText = message.text.trim();
                if (!userText) {
                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_error',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            message: '收到空消息，无法处理。',
                            timestamp: Date.now(),
                        },
                    });
                    return;
                }

                const threadId = `web-${message.conversationId}`;
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

                await adapter.sendStreamEvent({
                    inbound: message,
                    payload: {
                        type: 'reply_start',
                        sourceMessageId: message.messageId,
                        request_id: message.messageId,
                        conversationId: message.conversationId,
                        session_id: message.conversationId,
                        timestamp: Date.now(),
                    },
                });

                let rawStreamResponse = '';
                let visibleStreamResponse = '';
                let fullResponse = '';
                let finalOutputFromEvents = '';
                let sawToolCall = false;
                let attachments = [];

                try {
                    const eventStream = currentAgent.streamEvents(
                        { messages: invocationMessages },
                        {
                            configurable: { thread_id: threadId },
                            recursionLimit: config.agent.recursion_limit,
                            version: 'v2',
                        },
                    );

                    for await (const event of eventStream) {
                        if (event.event === 'on_chat_model_stream') {
                            const delta = extractStreamChunkText(event.data?.chunk?.content);
                            if (!delta) {
                                continue;
                            }
                            rawStreamResponse += delta;
                            const sanitizedCandidate = sanitizeUserFacingText(rawStreamResponse);
                            let deltaToSend = '';
                            if (!visibleStreamResponse && sanitizedCandidate) {
                                deltaToSend = sanitizedCandidate;
                                visibleStreamResponse = sanitizedCandidate;
                            } else if (sanitizedCandidate.startsWith(visibleStreamResponse)) {
                                deltaToSend = sanitizedCandidate.slice(visibleStreamResponse.length);
                                visibleStreamResponse = sanitizedCandidate;
                            }
                            if (!deltaToSend) {
                                continue;
                            }
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'reply_delta',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    delta: deltaToSend,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_tool_start') {
                            sawToolCall = true;
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'tool_start',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    toolName: event.name,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_tool_end') {
                            await adapter.sendStreamEvent({
                                inbound: message,
                                payload: {
                                    type: 'tool_end',
                                    sourceMessageId: message.messageId,
                                    request_id: message.messageId,
                                    conversationId: message.conversationId,
                                    session_id: message.conversationId,
                                    toolName: event.name,
                                    timestamp: Date.now(),
                                },
                            });
                            continue;
                        }

                        if (event.event === 'on_chat_model_end' || event.event === 'on_chain_end') {
                            const extracted = sanitizeUserFacingText(extractReplyTextFromEventData(event.data));
                            if (extracted && !isLikelyToolCallResidue(extracted) && !isLikelyStructuredToolPayload(extracted)) {
                                finalOutputFromEvents = extracted;
                            }

                            const eventData = event.data as { output?: { messages?: unknown[] }; messages?: unknown[] } | undefined;
                            const outputMessages = Array.isArray(eventData?.output?.messages)
                                ? eventData.output.messages
                                : Array.isArray(eventData?.messages)
                                    ? eventData.messages
                                    : null;
                            if (outputMessages) {
                                const bestFromMessages = extractBestReadableReplyFromMessages(outputMessages);
                                if (bestFromMessages) {
                                    finalOutputFromEvents = bestFromMessages;
                                }
                            }
                        }
                    }

                    fullResponse = pickBestUserFacingResponse([
                        finalOutputFromEvents,
                        sanitizeUserFacingText(rawStreamResponse),
                        rawStreamResponse,
                    ], {
                        sawToolCall,
                    });
                    attachments = await adapter.registerReplyAttachments(consumeQueuedWebReplyFiles());

                    if (!fullResponse && attachments.length > 0) {
                        fullResponse = '✅ 文件已生成，请下载附件。';
                    }
                    if (!fullResponse) {
                        fullResponse = '已处理，但没有可返回的文本结果。';
                    }

                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_final',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            text: fullResponse,
                            attachments,
                            finishReason: 'completed',
                            timestamp: Date.now(),
                        },
                    });
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn(`[Web] stream failed (${message.conversationId}): ${reason}`);
                    await adapter.sendStreamEvent({
                        inbound: message,
                        payload: {
                            type: 'reply_error',
                            sourceMessageId: message.messageId,
                            request_id: message.messageId,
                            conversationId: message.conversationId,
                            session_id: message.conversationId,
                            message: reason,
                            timestamp: Date.now(),
                        },
                    });
                }
            });

            return { skipReply: true };
        },
        logger: toGatewayLogger(log),
    });

    webAdapter = createWebChannelAdapter({
        config: webConfig,
        log,
        workspaceRoot: memoryWorkspacePath,
    });
    gateway.registerAdapter(webAdapter);
    await gateway.start();

    log.info(`[Web] UI available at http://${webConfig.host}:${webConfig.port}${webConfig.uiPath}`);
    log.info('[Web] Service started and ready for browser clients.');
    console.log();
    console.log(`${colors.gray}Open the Web UI in your browser. Press Ctrl+C to stop the Web service.${colors.reset}`);
    console.log();

    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log.info('[Web] Shutting down...');

        if (gateway) {
            try {
                await gateway.stop();
            } catch (error) {
                log.warn('[Web] gateway stop failed:', error instanceof Error ? error.message : String(error));
            }
        }

        if (cleanup) {
            try {
                await cleanup();
            } catch (error) {
                log.warn('[Web] MCP cleanup failed:', error instanceof Error ? error.message : String(error));
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
    startWebService({
        registerSignalHandlers: true,
        exitOnShutdown: true,
    }).catch((error) => {
        console.error(`${colors.red}Fatal error:${colors.reset}`, error);
        process.exit(1);
    });
}
