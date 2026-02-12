import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IOSConfig } from '../../config.js';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelInboundMessage,
    ChannelProactiveRequest,
    ChannelReplyRequest,
    GatewayDispatchResult,
} from '../gateway/types.js';
import type {
    IOSClientEnvelope,
    IOSConnectionState,
    IOSHelloPayload,
    IOSLogger,
    IOSMessagePayload,
    IOSServerEnvelope,
} from './types.js';

export interface IOSChannelAdapterOptions {
    config: IOSConfig;
    log: IOSLogger;
}

function parseClientEnvelope(raw: RawData): IOSClientEnvelope | null {
    let text = '';
    if (typeof raw === 'string') {
        text = raw;
    } else if (raw instanceof Buffer) {
        text = raw.toString('utf8');
    } else if (raw instanceof ArrayBuffer) {
        text = Buffer.from(raw).toString('utf8');
    } else if (Array.isArray(raw)) {
        text = Buffer.concat(raw).toString('utf8');
    } else if (ArrayBuffer.isView(raw)) {
        text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    }

    if (!text.trim()) return null;

    try {
        const parsed = JSON.parse(text) as IOSClientEnvelope;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

function normalizePath(path?: string): string {
    const normalized = path?.trim() || '/ws/ios';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function tryTrim(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

export class IOSChannelAdapter implements ChannelAdapter {
    readonly channel = 'ios';
    readonly capabilities = {
        supportsStreamingReply: false,
        supportsApprovalFlow: false,
        supportsAttachmentReply: false,
        supportsProactiveMessage: true,
    };

    private runtime: ChannelAdapterRuntime | null = null;
    private started = false;
    private server: WebSocketServer | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    private readonly connections = new Map<string, IOSConnectionState>();
    private readonly conversationIndex = new Map<string, Set<string>>();
    private readonly userIndex = new Map<string, Set<string>>();

    constructor(private readonly options: IOSChannelAdapterOptions) {}

    async start(runtime: ChannelAdapterRuntime): Promise<void> {
        if (this.started) return;

        this.runtime = runtime;
        const cfg = this.options.config;
        const path = normalizePath(cfg.path);
        const server = new WebSocketServer({
            host: cfg.host,
            port: cfg.port,
            path,
            maxPayload: cfg.maxPayloadBytes,
        });

        this.server = server;

        server.on('connection', (socket) => {
            this.handleConnection(socket);
        });
        server.on('error', (error) => {
            this.options.log.error('[IOSAdapter] websocket server error:', error instanceof Error ? error.message : String(error));
        });

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                server.off('listening', onListening);
                server.off('error', onError);
            };
            const onListening = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            server.once('listening', onListening);
            server.once('error', onError);
        });

        this.startHeartbeat();
        this.started = true;
        this.options.log.info(`[IOSAdapter] started at ws://${cfg.host}:${cfg.port}${path}`);
    }

    async stop(): Promise<void> {
        if (!this.started) return;

        this.started = false;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const state of this.connections.values()) {
            try {
                state.socket.close(1001, 'server shutdown');
            } catch {
                // ignore close errors on shutdown
            }
        }

        if (this.server) {
            const server = this.server;
            this.server = null;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }

        this.connections.clear();
        this.conversationIndex.clear();
        this.userIndex.clear();
        this.runtime = null;
        this.options.log.info('[IOSAdapter] stopped');
    }

    async sendReply(request: ChannelReplyRequest): Promise<void> {
        const targets = this.resolveReplyTargets(request.inbound);
        if (targets.size === 0) {
            throw new Error(`iOS reply target not found for conversation=${request.inbound.conversationId}`);
        }

        const payload: IOSServerEnvelope = {
            type: 'reply',
            messageId: request.inbound.messageId,
            conversationId: request.inbound.conversationId,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, payload);
    }

    async sendProactive(request: ChannelProactiveRequest): Promise<void> {
        const targets = this.resolveProactiveTargets(request.target);
        if (targets.size === 0) {
            throw new Error(`iOS proactive target not found: ${request.target}`);
        }

        const payload: IOSServerEnvelope = {
            type: 'proactive',
            target: request.target,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, payload);
    }

    async handleInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        if (!this.started || !this.runtime) {
            throw new Error('IOS adapter is not started');
        }
        return this.runtime.onInbound({
            ...message,
            channel: 'ios',
        });
    }

    private hasAuthToken(): boolean {
        return Boolean(this.options.config.authToken?.trim());
    }

    private handleConnection(socket: WebSocket): void {
        const state: IOSConnectionState = {
            connectionId: randomUUID(),
            socket,
            isAlive: true,
            authenticated: !this.hasAuthToken(),
        };

        this.connections.set(state.connectionId, state);

        socket.on('pong', () => {
            state.isAlive = true;
        });

        socket.on('message', (raw) => {
            void this.handleSocketMessage(state, raw);
        });

        socket.on('close', () => {
            this.handleDisconnect(state);
        });

        socket.on('error', (error) => {
            this.options.log.warn(`[IOSAdapter] socket error(${state.connectionId}):`, error instanceof Error ? error.message : String(error));
        });

        if (state.authenticated) {
            this.sendToConnection(state, {
                type: 'hello_ack',
                connectionId: state.connectionId,
                serverTime: Date.now(),
            });
        } else {
            this.sendToConnection(state, {
                type: 'hello_required',
                connectionId: state.connectionId,
                serverTime: Date.now(),
            });
        }

        this.options.log.info(`[IOSAdapter] connection opened: ${state.connectionId}`);
    }

    private async handleSocketMessage(state: IOSConnectionState, raw: RawData): Promise<void> {
        const envelope = parseClientEnvelope(raw);
        state.isAlive = true;

        if (!envelope) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'bad_json',
                message: '消息不是合法 JSON 或缺少 type 字段',
            });
            return;
        }

        if (envelope.type === 'ping') {
            this.sendToConnection(state, {
                type: 'pong',
                timestamp: Date.now(),
            });
            return;
        }

        if (envelope.type === 'hello') {
            this.handleHello(state, envelope);
            return;
        }

        if (this.hasAuthToken() && !state.authenticated) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'unauthorized',
                message: '请先发送 hello 完成认证',
            });
            try {
                state.socket.close(4401, 'unauthorized');
            } catch {
                // ignore close errors
            }
            return;
        }

        if (envelope.type === 'message') {
            await this.handleClientMessage(state, envelope);
            return;
        }

        this.sendToConnection(state, {
            type: 'error',
            code: 'unsupported_type',
            message: `不支持的消息类型: ${(envelope as { type?: string }).type || 'unknown'}`,
        });
    }

    private handleHello(state: IOSConnectionState, payload: IOSHelloPayload): void {
        const expectedToken = this.options.config.authToken?.trim();
        const providedToken = tryTrim(payload.token);

        if (expectedToken && providedToken !== expectedToken) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'auth_failed',
                message: '认证失败',
            });
            try {
                state.socket.close(4403, 'auth failed');
            } catch {
                // ignore close errors
            }
            return;
        }

        const previousConversation = state.conversationId;
        const previousUser = state.userId;

        state.authenticated = true;
        state.clientId = tryTrim(payload.clientId) || state.clientId;
        state.userId = tryTrim(payload.userId) || state.userId;
        state.userName = tryTrim(payload.userName) || state.userName;
        state.conversationId = tryTrim(payload.conversationId) || state.conversationId;
        state.conversationTitle = tryTrim(payload.conversationTitle) || state.conversationTitle;
        if (typeof payload.isDirect === 'boolean') {
            state.isDirect = payload.isDirect;
        }

        this.reindexConnection(state, previousConversation, previousUser);

        this.sendToConnection(state, {
            type: 'hello_ack',
            connectionId: state.connectionId,
            authenticated: true,
            serverTime: Date.now(),
        });
    }

    private async handleClientMessage(state: IOSConnectionState, payload: IOSMessagePayload): Promise<void> {
        if (!this.runtime) {
            throw new Error('IOS adapter runtime is not ready');
        }

        const text = payload.text?.trim();
        if (!text) {
            this.sendToConnection(state, {
                type: 'error',
                code: 'empty_text',
                message: 'message.text 不能为空',
            });
            return;
        }

        const previousConversation = state.conversationId;
        const previousUser = state.userId;

        const conversationId = payload.conversationId?.trim()
            || state.conversationId
            || `ios-conversation-${state.connectionId}`;
        const senderId = payload.senderId?.trim()
            || state.userId
            || `ios-user-${state.connectionId}`;
        const senderName = payload.senderName?.trim()
            || state.userName
            || 'iOS User';
        const isDirect = payload.isDirect ?? state.isDirect ?? true;

        state.conversationId = conversationId;
        state.conversationTitle = payload.conversationTitle?.trim() || state.conversationTitle;
        state.userId = senderId;
        state.userName = senderName;
        state.isDirect = isDirect;
        this.reindexConnection(state, previousConversation, previousUser);

        const messageId = payload.messageId?.trim() || `ios-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const inbound: ChannelInboundMessage = {
            channel: 'ios',
            messageId,
            idempotencyKey: payload.idempotencyKey?.trim() || messageId,
            timestamp: payload.timestamp || Date.now(),
            conversationId,
            conversationTitle: payload.conversationTitle?.trim() || state.conversationTitle,
            isDirect,
            senderId,
            senderName,
            text,
            messageType: 'text',
            metadata: {
                iosConnectionId: state.connectionId,
                iosClientId: state.clientId,
                iosUserId: state.userId,
                ...(payload.metadata || {}),
            },
            raw: payload,
        };

        let dispatchResult: GatewayDispatchResult;
        try {
            dispatchResult = await this.runtime.onInbound(inbound);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.sendToConnection(state, {
                type: 'dispatch_ack',
                messageId,
                status: 'error',
                reason,
                timestamp: Date.now(),
            });
            this.options.log.error('[IOSAdapter] dispatch failed(' + state.connectionId + '): ' + reason);
            return;
        }

        this.sendToConnection(state, {
            type: 'dispatch_ack',
            messageId,
            status: dispatchResult.status,
            reason: dispatchResult.reason,
            timestamp: Date.now(),
        });
    }

    private handleDisconnect(state: IOSConnectionState): void {
        this.connections.delete(state.connectionId);
        this.removeFromIndex(this.conversationIndex, state.conversationId, state.connectionId);
        this.removeFromIndex(this.userIndex, state.userId, state.connectionId);
        this.options.log.info(`[IOSAdapter] connection closed: ${state.connectionId}`);
    }

    private reindexConnection(state: IOSConnectionState, previousConversation?: string, previousUser?: string): void {
        this.removeFromIndex(this.conversationIndex, previousConversation, state.connectionId);
        this.removeFromIndex(this.userIndex, previousUser, state.connectionId);

        this.addToIndex(this.conversationIndex, state.conversationId, state.connectionId);
        this.addToIndex(this.userIndex, state.userId, state.connectionId);
    }

    private addToIndex(index: Map<string, Set<string>>, key: string | undefined, connectionId: string): void {
        const normalized = key?.trim();
        if (!normalized) return;
        const bucket = index.get(normalized) || new Set<string>();
        bucket.add(connectionId);
        index.set(normalized, bucket);
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string | undefined, connectionId: string): void {
        const normalized = key?.trim();
        if (!normalized) return;
        const bucket = index.get(normalized);
        if (!bucket) return;
        bucket.delete(connectionId);
        if (bucket.size === 0) {
            index.delete(normalized);
        }
    }

    private resolveReplyTargets(inbound: ChannelInboundMessage): Set<string> {
        const targets = new Set<string>();
        const metadata = inbound.metadata as Record<string, unknown> | undefined;
        const connectionId = tryTrim(metadata?.iosConnectionId);
        if (connectionId && this.connections.has(connectionId)) {
            targets.add(connectionId);
        }

        if (targets.size === 0) {
            const conversationTargets = this.conversationIndex.get(inbound.conversationId);
            if (conversationTargets) {
                for (const id of conversationTargets) {
                    targets.add(id);
                }
            }
        }

        if (targets.size === 0) {
            const userTargets = this.userIndex.get(inbound.senderId);
            if (userTargets) {
                for (const id of userTargets) {
                    targets.add(id);
                }
            }
        }

        return targets;
    }

    private resolveProactiveTargets(target: string): Set<string> {
        const normalized = target.trim();
        if (!normalized) return new Set();

        const directMatch = this.connections.get(normalized);
        if (directMatch) {
            return new Set([directMatch.connectionId]);
        }

        const separatorIdx = normalized.indexOf(':');
        const hasPrefix = separatorIdx > 0;
        const prefix = hasPrefix ? normalized.slice(0, separatorIdx).toLowerCase() : '';
        const key = hasPrefix ? normalized.slice(separatorIdx + 1).trim() : normalized;

        if (!key) return new Set();

        if (prefix === 'connection') {
            return this.connections.has(key) ? new Set([key]) : new Set();
        }
        if (prefix === 'user') {
            return new Set(this.userIndex.get(key) || []);
        }
        if (prefix === 'conversation') {
            return new Set(this.conversationIndex.get(key) || []);
        }

        // No prefix: default to conversation id.
        return new Set(this.conversationIndex.get(normalized) || []);
    }

    private broadcastToConnections(connectionIds: Set<string>, payload: IOSServerEnvelope): void {
        let delivered = 0;
        for (const connectionId of connectionIds) {
            const state = this.connections.get(connectionId);
            if (!state) continue;
            if (this.sendToConnection(state, payload)) {
                delivered += 1;
            }
        }
        if (delivered === 0) {
            throw new Error('没有可用的在线连接');
        }
    }

    private sendToConnection(state: IOSConnectionState, payload: IOSServerEnvelope): boolean {
        if (state.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            state.socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            this.options.log.warn(
                `[IOSAdapter] send failed(${state.connectionId}):`,
                error instanceof Error ? error.message : String(error)
            );
            return false;
        }
    }

    private startHeartbeat(): void {
        const intervalMs = this.options.config.pingIntervalMs ?? 30000;
        if (intervalMs <= 0) return;

        this.heartbeatTimer = setInterval(() => {
            for (const state of this.connections.values()) {
                if (!state.isAlive) {
                    try {
                        state.socket.terminate();
                    } catch {
                        // ignore terminate errors
                    }
                    continue;
                }
                state.isAlive = false;
                try {
                    state.socket.ping();
                } catch {
                    // ignore ping errors
                }
            }
        }, intervalMs);

        this.heartbeatTimer.unref?.();
    }
}

export function createIOSChannelAdapter(options: IOSChannelAdapterOptions): IOSChannelAdapter {
    return new IOSChannelAdapter(options);
}
