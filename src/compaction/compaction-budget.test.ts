import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getCompactionHardContextBudget,
    getCompactionHistoryTokenBudget,
    getEffectiveAutoCompactThreshold,
    shouldAutoCompact,
    type CompactionConfig,
} from './index.js';

test('compaction budget respects reserve_tokens as hard budget', () => {
    const config: CompactionConfig = {
        enabled: true,
        auto_compact_threshold: 120_000,
        context_window: 128_000,
        reserve_tokens: 20_000,
        max_history_share: 0.5,
    };

    assert.equal(getCompactionHardContextBudget(config), 108_000);
    assert.equal(getEffectiveAutoCompactThreshold(config), 108_000);
    assert.equal(getCompactionHistoryTokenBudget(config), 54_000);
    assert.equal(shouldAutoCompact(107_999, config), false);
    assert.equal(shouldAutoCompact(108_000, config), true);
});
