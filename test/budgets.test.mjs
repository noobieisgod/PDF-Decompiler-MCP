import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResultBudget, resolveBudget } from '../src/runtime/budget.mjs';

const items = Array.from({ length: 8 }, (_, index) => ({ id: `block:${index + 1}`, type: 'block', page: index + 1, text: 'evidence' }));

test('hard budget caps are applied and continuations are complete without duplicates', () => {
    const capped = resolveBudget({ responseBytes: 99_000_000, textBlocks: 2 });
    assert.equal(capped.responseBytes, 4_000_000);
    assert.equal(capped.textBlocks, 2);
    const collected = [];
    let offset = 0;
    do {
        const result = applyResultBudget(items, capped, offset);
        assert.ok(result.items.length <= 2);
        assert.equal(result.usage.textBlocks, result.items.length);
        collected.push(...result.items);
        offset = result.nextOffset;
    } while (offset !== null);
    assert.deepEqual(collected.map(item => item.id), items.map(item => item.id));
    assert.equal(new Set(collected.map(item => item.id)).size, items.length);
});

test('a single oversized item is omitted without exceeding the response limit', () => {
    const result = applyResultBudget([{ id: 'large', type: 'block', page: 1, text: 'x'.repeat(1000) }], resolveBudget({ responseBytes: 10 }));
    assert.equal(result.items.length, 0);
    assert.equal(result.omissions[0].reason, 'response_bytes');
    assert.equal(result.usage.responseBytes, 0);
});
