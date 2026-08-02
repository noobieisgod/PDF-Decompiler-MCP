import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFairPageBudget, applyResultBudget, resolveBudget } from '../src/runtime/budget.mjs';

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

test('fair page budgeting is deterministic, resumable, and advances beyond permanently oversized items', () => {
    const pageItems = [
        { page: 1, items: [{ id: 'p1-large', type: 'block', page: 1, text: 'x'.repeat(1000) }, { id: 'p1-small', type: 'block', page: 1, text: 'one' }] },
        { page: 2, items: [{ id: 'p2-small', type: 'block', page: 2, text: 'two' }] },
        { page: 3, items: [{ id: 'p3-small', type: 'block', page: 3, text: 'three' }] },
    ];
    const budget = resolveBudget({ responseBytes: 250, estimatedTokens: 1000, textBlocks: 3, pages: 3 });
    const first = applyFairPageBudget(pageItems, budget);
    assert.ok(first.omissions.some(omission => omission.id === 'p1-large'));
    assert.deepEqual(new Set(first.items.map(item => item.page)), new Set([1, 2, 3]));
    assert.equal(first.nextPosition, null);
    assert.deepEqual(applyFairPageBudget(pageItems, budget), first);
});

test('fair page cursor positions do not duplicate or skip elements across continuations', () => {
    const pageItems = Array.from({ length: 3 }, (_, page) => ({
        page: page + 1,
        items: Array.from({ length: 4 }, (_, index) => ({ id: `${page + 1}:${index}`, type: 'block', page: page + 1, text: 'bounded payload' })),
    }));
    const budget = resolveBudget({ responseBytes: 220, estimatedTokens: 1000, textBlocks: 3, pages: 3 });
    const ids = [];
    let position = null;
    do {
        const page = applyFairPageBudget(pageItems, budget, position);
        assert.ok(page.items.length > 0 || page.omissions.length > 0);
        ids.push(...page.items.map(item => item.id));
        position = page.nextPosition;
    } while (position);
    assert.equal(ids.length, 12);
    assert.equal(new Set(ids).size, ids.length);
});
