import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractBestReadableReplyFromMessages,
    extractReplyTextFromEventData,
    extractStreamChunkText,
    isLikelyToolCallResidue,
    pickBestUserFacingResponse,
    sanitizeUserFacingText,
} from './streaming.js';

test('extractStreamChunkText handles string and block arrays', () => {
    assert.equal(extractStreamChunkText('hello'), 'hello');
    assert.equal(
        extractStreamChunkText([{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
        'line one\nline two'
    );
});

test('extractReplyTextFromEventData reads nested output messages', () => {
    const data = {
        output: {
            messages: [
                { role: 'user', content: 'ignored' },
                { role: 'assistant', content: [{ text: 'final reply' }] },
            ],
        },
    };

    assert.equal(extractReplyTextFromEventData(data), 'final reply');
});

test('sanitizeUserFacingText removes tool call residue', () => {
    const dirty = [
        '开始处理',
        '<tool_call name="memory_search">',
        '{"query":"昨天"}',
        '</tool_call>',
        '最终答案',
    ].join('\n');

    const cleaned = sanitizeUserFacingText(dirty);
    assert.match(cleaned, /开始处理/);
    assert.match(cleaned, /最终答案/);
    assert.doesNotMatch(cleaned, /tool_call/);
    assert.doesNotMatch(cleaned, /"query":"昨天"/);
});

test('extractBestReadableReplyFromMessages prefers assistant content', () => {
    const messages = [
        { role: 'tool', content: '{"ok":true}' },
        { role: 'assistant', content: '这是最终答复' },
    ];

    assert.equal(extractBestReadableReplyFromMessages(messages), '这是最终答复');
});

test('pickBestUserFacingResponse skips tool payload when tool was called', () => {
    const picked = pickBestUserFacingResponse(
        ['{"temperature":18,"humidity":30,"city":"Hangzhou"}', '杭州今天 18 度，湿度 30%。'],
        { sawToolCall: true },
    );

    assert.equal(picked, '杭州今天 18 度，湿度 30%。');
});

test('isLikelyToolCallResidue identifies empty tool syntax', () => {
    assert.equal(isLikelyToolCallResidue('<tool_call name="x">'), true);
});
