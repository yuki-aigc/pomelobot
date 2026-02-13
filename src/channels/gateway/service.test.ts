import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayService } from './service.js';
import type {
    ChannelAdapter,
    ChannelAdapterRuntime,
    ChannelInboundMessage,
    ChannelReplyRequest,
} from './types.js';

function createInbound(overrides?: Partial<ChannelInboundMessage>): ChannelInboundMessage {
    return {
        channel: 'ios',
        messageId: 'msg-1',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        isDirect: true,
        senderId: 'user-1',
        senderName: 'User One',
        text: 'hello',
        ...overrides,
    };
}

test('GatewayService deduplicates inbound messages by messageId', async () => {
    let runtime: ChannelAdapterRuntime | null = null;
    let processCount = 0;
    let replyCount = 0;

    const adapter: ChannelAdapter = {
        channel: 'ios',
        capabilities: {
            supportsStreamingReply: false,
            supportsApprovalFlow: false,
            supportsAttachmentReply: false,
            supportsProactiveMessage: false,
        },
        start: async (inRuntime) => {
            runtime = inRuntime;
        },
        stop: async () => undefined,
        sendReply: async (_request: ChannelReplyRequest) => {
            replyCount += 1;
        },
    };

    const gateway = new GatewayService({
        dedupeTtlMs: 5_000,
        onProcessInbound: async () => {
            processCount += 1;
            return {
                reply: {
                    text: 'ok',
                },
            };
        },
    });

    gateway.registerAdapter(adapter);
    await gateway.start();
    assert.ok(runtime, 'adapter runtime should be initialized');

    const inbound = createInbound();
    const first = await gateway.dispatchInbound(inbound);
    const duplicate = await gateway.dispatchInbound(inbound);

    assert.equal(first.status, 'processed');
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(processCount, 1);
    assert.equal(replyCount, 1);

    await gateway.stop();
});

test('GatewayService processes same messageId when idempotency key differs', async () => {
    let processCount = 0;

    const adapter: ChannelAdapter = {
        channel: 'ios',
        capabilities: {
            supportsStreamingReply: false,
            supportsApprovalFlow: false,
            supportsAttachmentReply: false,
            supportsProactiveMessage: false,
        },
        start: async () => undefined,
        stop: async () => undefined,
        sendReply: async () => undefined,
    };

    const gateway = new GatewayService({
        dedupeTtlMs: 5_000,
        onProcessInbound: async () => {
            processCount += 1;
            return {
                skipReply: true,
            };
        },
    });

    gateway.registerAdapter(adapter);
    await gateway.start();

    const first = await gateway.dispatchInbound(createInbound({ messageId: 'same', idempotencyKey: 'key-a' }));
    const second = await gateway.dispatchInbound(createInbound({ messageId: 'same', idempotencyKey: 'key-b' }));

    assert.equal(first.status, 'skipped');
    assert.equal(second.status, 'skipped');
    assert.equal(processCount, 2);

    await gateway.stop();
});
