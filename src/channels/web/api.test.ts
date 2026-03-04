import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WebSessionRegistry,
    createWebSessionId,
    normalizeWebSessionId,
    resolveHelloIdentity,
    resolveMessageIdentity,
} from './api.js';
import type { WebConnectionState } from './types.js';

function buildState(): WebConnectionState {
    return {
        connectionId: 'conn-1',
        socket: {} as WebConnectionState['socket'],
        request: {} as WebConnectionState['request'],
        isAlive: true,
        authenticated: true,
    };
}

test('createWebSessionId generates normalized session id', () => {
    const sessionId = createWebSessionId();
    assert.match(sessionId, /^wsn_[a-z0-9]+$/i);
    assert.equal(normalizeWebSessionId(sessionId), sessionId);
});

test('resolveHelloIdentity prefers snake_case api fields', () => {
    const identity = resolveHelloIdentity({
        type: 'hello',
        user_id: 'user-1',
        nick_name: 'Hunter',
        session_id: 'session_12345678',
        client_id: 'frontend-a',
    }, buildState());

    assert.equal(identity.userId, 'user-1');
    assert.equal(identity.nickName, 'Hunter');
    assert.equal(identity.requestedSessionId, 'session_12345678');
    assert.equal(identity.clientId, 'frontend-a');
});

test('resolveMessageIdentity accepts request_id alias', () => {
    const identity = resolveMessageIdentity({
        type: 'message',
        request_id: 'req-1',
        user_id: 'user-1',
        nick_name: 'Hunter',
        session_id: 'session_abcdefgh',
        text: 'hello',
    }, buildState());

    assert.equal(identity.messageId, 'req-1');
    assert.equal(identity.idempotencyKey, 'req-1');
    assert.equal(identity.userId, 'user-1');
    assert.equal(identity.nickName, 'Hunter');
    assert.equal(identity.requestedSessionId, 'session_abcdefgh');
});

test('WebSessionRegistry prevents cross-user session reuse', () => {
    const registry = new WebSessionRegistry();
    const first = registry.bind({
        requestedSessionId: 'session_reuse_123',
        userId: 'user-a',
        nickName: 'A',
    });
    assert.equal(first.ok, true);

    const second = registry.bind({
        requestedSessionId: 'session_reuse_123',
        userId: 'user-b',
        nickName: 'B',
    });

    assert.equal(second.ok, false);
    if (!second.ok) {
        assert.equal(second.code, 'session_conflict');
    }
});
