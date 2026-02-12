import type { WebSocket } from 'ws';

export interface IOSLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export interface IOSHelloPayload {
    type: 'hello';
    token?: string;
    clientId?: string;
    userId?: string;
    userName?: string;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
    metadata?: Record<string, unknown>;
}

export interface IOSMessagePayload {
    type: 'message';
    messageId?: string;
    idempotencyKey?: string;
    timestamp?: number;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
    senderId?: string;
    senderName?: string;
    text?: string;
    metadata?: Record<string, unknown>;
}

export interface IOSPingPayload {
    type: 'ping';
    timestamp?: number;
}

export type IOSClientEnvelope = IOSHelloPayload | IOSMessagePayload | IOSPingPayload;

export interface IOSServerEnvelope {
    type: string;
    [key: string]: unknown;
}

export interface IOSConnectionState {
    connectionId: string;
    socket: WebSocket;
    isAlive: boolean;
    authenticated: boolean;
    clientId?: string;
    userId?: string;
    userName?: string;
    conversationId?: string;
    conversationTitle?: string;
    isDirect?: boolean;
}
