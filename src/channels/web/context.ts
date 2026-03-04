import {
    withChannelConversationContext,
    getChannelConversationContext,
    queueChannelReplyFile,
    consumeQueuedChannelReplyFiles,
} from '../context.js';

export interface WebConversationContext {
    conversationId: string;
    isDirect: boolean;
    senderId: string;
    senderName: string;
    workspaceRoot?: string;
    pendingReplyFiles?: string[];
}

export function withWebConversationContext<T>(
    context: WebConversationContext,
    fn: () => Promise<T>,
): Promise<T> {
    return withChannelConversationContext(
        {
            channel: 'web',
            ...context,
        },
        fn,
    );
}

export function getWebConversationContext(): WebConversationContext | undefined {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'web') {
        return undefined;
    }
    return {
        conversationId: context.conversationId,
        isDirect: context.isDirect,
        senderId: context.senderId,
        senderName: context.senderName,
        workspaceRoot: context.workspaceRoot,
        pendingReplyFiles: context.pendingReplyFiles,
    };
}

export function queueWebReplyFile(filePath: string): boolean {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'web') {
        return false;
    }
    return queueChannelReplyFile(filePath);
}

export function consumeQueuedWebReplyFiles(): string[] {
    const context = getChannelConversationContext();
    if (!context || context.channel !== 'web') {
        return [];
    }
    return consumeQueuedChannelReplyFiles();
}
