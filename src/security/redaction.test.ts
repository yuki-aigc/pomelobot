import test from 'node:test';
import assert from 'node:assert/strict';

import { redactSensitiveData, redactSensitiveText } from './redaction.js';

test('redactSensitiveText masks token-like substrings', () => {
    const input = 'Authorization: Bearer sk-1234567890abcdef token=abc123';
    const output = redactSensitiveText(input);

    assert.match(output, /Authorization: Bearer \[REDACTED\]/);
    assert.match(output, /token=\[REDACTED\]/i);
});

test('redactSensitiveData masks sensitive keys recursively', () => {
    const input = {
        api_key: 'secret-value',
        nested: {
            password: 'p@ss',
            note: 'safe',
        },
    };

    const output = redactSensitiveData(input) as {
        api_key: string;
        nested: { password: string; note: string };
    };

    assert.equal(output.api_key, '[REDACTED]');
    assert.equal(output.nested.password, '[REDACTED]');
    assert.equal(output.nested.note, 'safe');
});
