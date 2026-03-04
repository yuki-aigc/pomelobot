import { createServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { WebConfig } from '../../config.js';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelInboundMessage,
    ChannelProactiveRequest,
    ChannelReplyRequest,
    GatewayDispatchResult,
} from '../gateway/types.js';
import { renderWebChatPage } from './ui.js';
import {
    WebSessionRegistry,
    resolveHelloIdentity,
    resolveMessageIdentity,
} from './api.js';
import {
    MAX_WEB_REPLY_FILE_BYTES,
    buildAttachmentBasePath,
    buildContentDisposition,
    guessMimeType,
    isPathInsideDir,
    resolvePathFromWorkspace,
} from './file-utils.js';
import type {
    WebAttachmentPayload,
    WebAttachmentRecord,
    WebClientEnvelope,
    WebConnectionState,
    WebHelloPayload,
    WebLogger,
    WebMessagePayload,
    WebServerEnvelope,
} from './types.js';

export interface WebChannelAdapterOptions {
    config: WebConfig;
    log: WebLogger;
    workspaceRoot: string;
}

export interface WebStreamRequest {
    inbound: ChannelInboundMessage;
    payload: WebServerEnvelope;
}

const ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_API_PATH = '/api/web/sessions';

function parseClientEnvelope(raw: RawData): WebClientEnvelope | null {
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
        const parsed = JSON.parse(text) as WebClientEnvelope;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

function normalizePath(path?: string, fallback: string = '/ws/web'): string {
    const normalized = path?.trim() || fallback;
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function tryTrim(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

export class WebChannelAdapter implements ChannelAdapter {
    readonly channel = 'web';
    readonly capabilities = {
        supportsStreamingReply: true,
        supportsApprovalFlow: false,
        supportsAttachmentReply: true,
        supportsProactiveMessage: true,
    };

    private runtime: ChannelAdapterRuntime | null = null;
    private started = false;
    private server: HTTPServer | null = null;
    private wsServer: WebSocketServer | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    private readonly connections = new Map<string, WebConnectionState>();
    private readonly conversationIndex = new Map<string, Set<string>>();
    private readonly userIndex = new Map<string, Set<string>>();
    private readonly attachmentRegistry = new Map<string, WebAttachmentRecord>();
    private readonly sessionRegistry = new WebSessionRegistry();

    constructor(private readonly options: WebChannelAdapterOptions) {}

    async start(runtime: ChannelAdapterRuntime): Promise<void> {
        if (this.started) return;

        this.runtime = runtime;
        const cfg = this.options.config;
        const wsPath = normalizePath(cfg.path, '/ws/web');
        const uiPath = normalizePath(cfg.uiPath, '/web');
        const server = createServer((req, res) => {
            void this.handleHttpRequest(req, res, uiPath);
        });
        const wsServer = new WebSocketServer({
            server,
            path: wsPath,
            maxPayload: cfg.maxPayloadBytes,
        });

        this.server = server;
        this.wsServer = wsServer;

        wsServer.on('connection', (socket, request) => {
            this.handleConnection(socket, request);
        });
        wsServer.on('error', (error) => {
            this.options.log.error('[WebAdapter] websocket server error:', error instanceof Error ? error.message : String(error));
        });
        server.on('error', (error) => {
            this.options.log.error('[WebAdapter] http server error:', error instanceof Error ? error.message : String(error));
        });

        await new Promise<void>((resolve, reject) => {
            server.listen(cfg.port, cfg.host, () => resolve());
            server.once('error', reject);
        });

        this.startHeartbeat();
        this.started = true;
        this.options.log.info(`[WebAdapter] UI ready at http://${cfg.host}:${cfg.port}${uiPath}`);
        this.options.log.info(`[WebAdapter] websocket ready at ws://${cfg.host}:${cfg.port}${wsPath}`);
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

        if (this.wsServer) {
            const wsServer = this.wsServer;
            this.wsServer = null;
            await new Promise<void>((resolve) => {
                wsServer.close(() => resolve());
            });
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
        this.attachmentRegistry.clear();
        this.sessionRegistry.clear();
        this.runtime = null;
        this.options.log.info('[WebAdapter] stopped');
    }

    async sendReply(request: ChannelReplyRequest): Promise<void> {
        const targets = this.resolveReplyTargets(request.inbound);
        if (targets.size === 0) {
            throw new Error(`web reply target not found for conversation=${request.inbound.conversationId}`);
        }

        const attachments = await this.registerReplyAttachments(request.message.attachments || []);
        const payload: WebServerEnvelope = {
            type: 'reply',
            messageId: request.inbound.messageId,
            request_id: request.inbound.messageId,
            conversationId: request.inbound.conversationId,
            session_id: request.inbound.conversationId,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            attachments,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, payload);
    }

    async sendStreamEvent(request: WebStreamRequest): Promise<void> {
        const targets = this.resolveReplyTargets(request.inbound);
        if (targets.size === 0) {
            throw new Error(`web stream target not found for conversation=${request.inbound.conversationId}`);
        }
        this.broadcastToConnections(targets, request.payload);
    }

    async sendProactive(request: ChannelProactiveRequest): Promise<void> {
        const targets = this.resolveProactiveTargets(request.target);
        if (targets.size === 0) {
            throw new Error(`web proactive target not found: ${request.target}`);
        }

        const attachments = await this.registerReplyAttachments(request.message.attachments || []);
        const payload: WebServerEnvelope = {
            type: 'proactive',
            target: request.target,
            session_id: request.target,
            text: request.message.text,
            title: request.message.title,
            useMarkdown: request.message.useMarkdown,
            attachments,
            metadata: request.message.metadata,
            timestamp: Date.now(),
        };

        this.broadcastToConnections(targets, payload);
    }

    async handleInbound(message: ChannelInboundMessage): Promise<GatewayDispatchResult> {
        if (!this.started || !this.runtime) {
            throw new Error('Web adapter is not started');
        }
        return this.runtime.onInbound({
            ...message,
            channel: 'web',
        });
    }

    async registerReplyAttachments(paths: string[]): Promise<WebAttachmentPayload[]> {
        this.cleanupExpiredAttachments();
        const attachments: WebAttachmentPayload[] = [];
        const seen = new Set<string>();
        const workspaceTmpRoot = path.resolve(this.options.workspaceRoot, 'tmp');
        const uiPath = normalizePath(this.options.config.uiPath, '/web');
        const attachmentBasePath = buildAttachmentBasePath(uiPath);

        for (const rawPath of paths) {
            const trimmed = rawPath.trim();
            if (!trimmed) continue;

            let resolved = '';
            try {
                resolved = resolvePathFromWorkspace(this.options.workspaceRoot, trimmed);
            } catch (error) {
                this.options.log.warn(`[WebAdapter] attachment path resolve failed: ${String(error)}`);
                continue;
            }
            if (seen.has(resolved)) {
                continue;
            }
            seen.add(resolved);

            if (!isPathInsideDir(resolved, workspaceTmpRoot)) {
                this.options.log.warn(`[WebAdapter] skip attachment outside workspace/tmp: ${resolved}`);
                continue;
            }

            let stat;
            try {
                stat = await fsPromises.stat(resolved);
            } catch {
                this.options.log.warn(`[WebAdapter] attachment not found: ${resolved}`);
                continue;
            }
            if (!stat.isFile()) {
                this.options.log.warn(`[WebAdapter] skip non-file attachment: ${resolved}`);
                continue;
            }
            if (stat.size <= 0) {
                this.options.log.warn(`[WebAdapter] skip empty attachment: ${resolved}`);
                continue;
            }
            if (stat.size > MAX_WEB_REPLY_FILE_BYTES) {
                this.options.log.warn(`[WebAdapter] skip oversized attachment: ${resolved}`);
                continue;
            }

            const id = randomUUID().replace(/-/g, '');
            const name = path.basename(resolved);
            const record: WebAttachmentRecord = {
                id,
                name,
                path: resolved,
                url: `${attachmentBasePath}/${id}/${encodeURIComponent(name)}`,
                sizeBytes: stat.size,
                mimeType: guessMimeType(resolved),
                createdAt: Date.now(),
                expiresAt: Date.now() + ATTACHMENT_TTL_MS,
            };
            this.attachmentRegistry.set(id, record);
            attachments.push({
                id: record.id,
                name: record.name,
                url: record.url,
                sizeBytes: record.sizeBytes,
                mimeType: record.mimeType,
            });
        }

        return attachments;
    }

    private async handleHttpRequest(req: IncomingMessage, res: ServerResponse, uiPath: string): Promise<void> {
        const method = req.method || 'GET';
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const attachmentBasePath = buildAttachmentBasePath(uiPath);
        if (method === 'OPTIONS' && url.pathname === SESSION_API_PATH) {
            this.writeApiCorsHeaders(res);
            res.writeHead(204);
            res.end();
            return;
        }
        if (method === 'GET' && url.pathname === '/healthz') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('ok');
            return;
        }

        if (method === 'POST' && url.pathname === SESSION_API_PATH) {
            await this.handleCreateSessionRequest(req, res);
            return;
        }

        if (method === 'GET' && (url.pathname === uiPath || (uiPath !== '/' && url.pathname === '/'))) {
            if (url.pathname === '/' && uiPath !== '/') {
                res.writeHead(302, { location: uiPath });
                res.end();
                return;
            }
            const html = renderWebChatPage(this.options.config);
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(html);
            return;
        }

        if (method === 'GET' && (url.pathname === attachmentBasePath || url.pathname.startsWith(`${attachmentBasePath}/`))) {
            await this.handleAttachmentRequest(url.pathname, res, attachmentBasePath);
            return;
        }

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }

    private async handleAttachmentRequest(
        pathname: string,
        res: ServerResponse,
        attachmentBasePath: string,
    ): Promise<void> {
        this.cleanupExpiredAttachments();
        const attachmentId = decodeURIComponent(pathname.slice(attachmentBasePath.length + 1).split('/')[0] || '');
        if (!attachmentId) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Attachment Not Found');
            return;
        }

        const record = this.attachmentRegistry.get(attachmentId);
        if (!record || record.expiresAt <= Date.now()) {
            this.attachmentRegistry.delete(attachmentId);
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Attachment Not Found');
            return;
        }

        try {
            const stat = await fsPromises.stat(record.path);
            if (!stat.isFile()) {
                throw new Error('Attachment is not a file');
            }
            res.writeHead(200, {
                'content-type': record.mimeType,
                'content-length': String(stat.size),
                'content-disposition': buildContentDisposition(record.name),
                'cache-control': 'private, max-age=300',
                'x-content-type-options': 'nosniff',
            });
            await pipeline(createReadStream(record.path), res);
        } catch (error) {
            this.options.log.warn(`[WebAdapter] attachment send failed: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            }
            res.end('Attachment Not Found');
        }
    }

    private async handleCreateSessionRequest(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        try {
            const body = await this.readJsonBody(req);
            const userId = typeof body.user_id === 'string'
                ? body.user_id.trim()
                : typeof body.userId === 'string'
                    ? body.userId.trim()
                    : '';
            const nickName = typeof body.nick_name === 'string'
                ? body.nick_name.trim()
                : typeof body.nickName === 'string'
                    ? body.nickName.trim()
                    : '';
            const requestedSessionId = typeof body.session_id === 'string'
                ? body.session_id.trim()
                : typeof body.sessionId === 'string'
                    ? body.sessionId.trim()
                    : undefined;
            const sessionTitle = typeof body.session_title === 'string'
                ? body.session_title.trim()
                : typeof body.sessionTitle === 'string'
                    ? body.sessionTitle.trim()
                    : undefined;

            if (!userId) {
                this.writeApiCorsHeaders(res);
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: false,
                    error: {
                        code: 'bad_request',
                        message: 'user_id 不能为空',
                    },
                }));
                return;
            }

            const result = this.sessionRegistry.bind({
                requestedSessionId,
                userId,
                nickName: nickName || userId,
                sessionTitle,
            });
            if (!result.ok) {
                this.writeApiCorsHeaders(res);
                res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: false,
                    error: {
                        code: result.code,
                        message: result.reason,
                    },
                }));
                return;
            }

            this.writeApiCorsHeaders(res);
            res.writeHead(result.created ? 201 : 200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify({
                ok: true,
                session_id: result.session.sessionId,
                user_id: result.session.userId,
                nick_name: result.session.nickName,
                session_title: result.session.sessionTitle,
                created_at: result.session.createdAt,
                reused: !result.created,
            }));
        } catch (error) {
            this.writeApiCorsHeaders(res);
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: false,
                error: {
                    code: 'bad_request',
                    message: error instanceof Error ? error.message : String(error),
                },
            }));
        }
    }

    private hasAuthToken(): boolean {
        return Boolean(this.options.config.authToken?.trim());
    }

    private handleConnection(socket: WebSocket, request: IncomingMessage): void {
        const state: WebConnectionState = {
            connectionId: randomUUID(),
            socket,
            request,
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
            this.options.log.warn(`[WebAdapter] socket error(${state.connectionId}):`, error instanceof Error ? error.message : String(error));
        });

        this.sendToConnection(state, {
            type: 'hello_required',
            connectionId: state.connectionId,
            connection_id: state.connectionId,
            authenticated: state.authenticated,
            serverTime: Date.now(),
        });

        this.options.log.info(`[WebAdapter] connection opened: ${state.connectionId}`);
    }

    private async handleSocketMessage(state: WebConnectionState, raw: RawData): Promise<void> {
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

    private handleHello(state: WebConnectionState, payload: WebHelloPayload): void {
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

        const identity = resolveHelloIdentity(payload, state);
        const sessionResult = this.sessionRegistry.bind({
            requestedSessionId: identity.requestedSessionId,
            userId: identity.userId,
            nickName: identity.nickName,
            sessionTitle: identity.sessionTitle,
        });
        if (!sessionResult.ok) {
            this.sendToConnection(state, {
                type: 'error',
                code: sessionResult.code,
                message: sessionResult.reason,
            });
            return;
        }

        state.authenticated = true;
        state.clientId = identity.clientId || state.clientId;
        state.userId = identity.userId;
        state.userName = identity.nickName;
        state.conversationId = sessionResult.session.sessionId;
        state.conversationTitle = sessionResult.session.sessionTitle;
        state.isDirect = identity.isDirect;

        this.reindexConnection(state, previousConversation, previousUser);

        this.sendToConnection(state, {
            type: 'hello_ack',
            connectionId: state.connectionId,
            connection_id: state.connectionId,
            authenticated: true,
            client_id: state.clientId,
            clientId: state.clientId,
            user_id: state.userId,
            userId: state.userId,
            nick_name: state.userName,
            userName: state.userName,
            session_id: state.conversationId,
            sessionId: state.conversationId,
            session_title: state.conversationTitle,
            conversationTitle: state.conversationTitle,
            api_path: SESSION_API_PATH,
            serverTime: Date.now(),
        });
    }

    private async handleClientMessage(state: WebConnectionState, payload: WebMessagePayload): Promise<void> {
        if (!this.runtime) {
            throw new Error('Web adapter runtime is not ready');
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
        const identity = resolveMessageIdentity(payload, state);
        const sessionResult = this.sessionRegistry.bind({
            requestedSessionId: identity.requestedSessionId,
            userId: identity.userId,
            nickName: identity.nickName,
            sessionTitle: identity.sessionTitle,
        });
        if (!sessionResult.ok) {
            this.sendToConnection(state, {
                type: 'dispatch_ack',
                messageId: identity.messageId,
                message_id: identity.messageId,
                request_id: identity.messageId,
                status: 'error',
                reason: sessionResult.reason,
                session_id: identity.requestedSessionId,
                sessionId: identity.requestedSessionId,
                timestamp: Date.now(),
            });
            return;
        }

        state.conversationId = sessionResult.session.sessionId;
        state.conversationTitle = sessionResult.session.sessionTitle;
        state.userId = identity.userId;
        state.userName = identity.nickName;
        state.isDirect = identity.isDirect;
        this.reindexConnection(state, previousConversation, previousUser);
        const inbound: ChannelInboundMessage = {
            channel: 'web',
            messageId: identity.messageId,
            idempotencyKey: identity.idempotencyKey,
            timestamp: identity.timestamp,
            conversationId: state.conversationId,
            conversationTitle: state.conversationTitle,
            isDirect: state.isDirect ?? true,
            senderId: state.userId || `web-user-${state.connectionId}`,
            senderName: state.userName || 'Web User',
            text,
            messageType: 'text',
            workspaceRoot: this.options.workspaceRoot,
            metadata: {
                webConnectionId: state.connectionId,
                webClientId: state.clientId,
                webUserId: state.userId,
                webSessionId: state.conversationId,
                webUserAgent: state.request.headers['user-agent'] || '',
                webOrigin: state.request.headers.origin || '',
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
                messageId: identity.messageId,
                message_id: identity.messageId,
                request_id: identity.messageId,
                status: 'error',
                reason,
                session_id: state.conversationId,
                sessionId: state.conversationId,
                timestamp: Date.now(),
            });
            this.options.log.error('[WebAdapter] dispatch failed(' + state.connectionId + '): ' + reason);
            return;
        }

        this.sendToConnection(state, {
            type: 'dispatch_ack',
            messageId: identity.messageId,
            message_id: identity.messageId,
            request_id: identity.messageId,
            status: dispatchResult.status,
            reason: dispatchResult.reason,
            session_id: state.conversationId,
            sessionId: state.conversationId,
            timestamp: Date.now(),
        });
    }

    private handleDisconnect(state: WebConnectionState): void {
        this.connections.delete(state.connectionId);
        this.removeFromIndex(this.conversationIndex, state.conversationId, state.connectionId);
        this.removeFromIndex(this.userIndex, state.userId, state.connectionId);
        this.options.log.info(`[WebAdapter] connection closed: ${state.connectionId}`);
    }

    private reindexConnection(state: WebConnectionState, previousConversation?: string, previousUser?: string): void {
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
        const connectionId = tryTrim(metadata?.webConnectionId);
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

        return new Set(this.conversationIndex.get(normalized) || []);
    }

    private broadcastToConnections(connectionIds: Set<string>, payload: WebServerEnvelope): void {
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

    private sendToConnection(state: WebConnectionState, payload: WebServerEnvelope): boolean {
        if (state.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            state.socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            this.options.log.warn(
                `[WebAdapter] send failed(${state.connectionId}):`,
                error instanceof Error ? error.message : String(error),
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

    private cleanupExpiredAttachments(now: number = Date.now()): void {
        for (const [id, record] of this.attachmentRegistry.entries()) {
            if (record.expiresAt <= now) {
                this.attachmentRegistry.delete(id);
            }
        }
    }

    private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            chunks.push(buffer);
            const currentSize = chunks.reduce((sum, item) => sum + item.length, 0);
            if (currentSize > 64 * 1024) {
                throw new Error('请求体过大');
            }
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('请求体必须是 JSON 对象');
        }
        return parsed as Record<string, unknown>;
    }

    private writeApiCorsHeaders(res: ServerResponse): void {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type, authorization');
    }
}

export function createWebChannelAdapter(options: WebChannelAdapterOptions): WebChannelAdapter {
    return new WebChannelAdapter(options);
}
