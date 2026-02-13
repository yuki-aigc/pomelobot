import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAgentResponseText, extractTextContent } from './runtime-entry.js';

test('extractTextContent handles mixed block arrays', () => {
    const content = [
        'line one',
        { text: 'line two' },
        { text: '  ' },
        { value: 'ignored' },
    ];

    assert.equal(extractTextContent(content), 'line one\nline two');
});

test('extractAgentResponseText returns last message content', () => {
    const result = {
        messages: [
            { content: 'first' },
            { content: [{ text: 'final reply' }] },
        ],
    };

    assert.equal(extractAgentResponseText(result), 'final reply');
});

test('extractAgentResponseText returns empty string for invalid shape', () => {
    assert.equal(extractAgentResponseText(null), '');
    assert.equal(extractAgentResponseText({}), '');
});
