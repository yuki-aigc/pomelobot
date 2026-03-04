import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAttachmentBasePath,
    buildContentDisposition,
    guessMimeType,
    isPathInsideDir,
    sanitizeFileName,
} from './file-utils.js';

test('sanitizeFileName removes invalid path characters', () => {
    assert.equal(sanitizeFileName(' report:/bad?.md '), 'report--bad-.md');
});

test('isPathInsideDir accepts children and rejects siblings', () => {
    assert.equal(isPathInsideDir('/tmp/workspace/tmp/a.txt', '/tmp/workspace/tmp'), true);
    assert.equal(isPathInsideDir('/tmp/workspace/other/a.txt', '/tmp/workspace/tmp'), false);
});

test('guessMimeType falls back to octet-stream', () => {
    assert.equal(guessMimeType('/tmp/report.md'), 'text/markdown; charset=utf-8');
    assert.equal(guessMimeType('/tmp/blob.bin'), 'application/octet-stream');
});

test('buildAttachmentBasePath and content disposition are stable', () => {
    assert.equal(buildAttachmentBasePath('/web'), '/web/attachments');
    assert.equal(buildAttachmentBasePath('/'), '/attachments');
    assert.match(buildContentDisposition('报告 1.md'), /filename\*=UTF-8''/);
});
