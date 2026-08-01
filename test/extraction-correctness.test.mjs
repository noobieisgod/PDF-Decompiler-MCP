import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/runtime.mjs';
import { anchorLinkAnnotations } from '../src/extract/links.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { LinkElementSchema, ParserErrorCodeSchema } from '../src/server/schemas.mjs';

const fixtureRoot = path.resolve('test/fixtures/generated');

async function managerFor(t) {
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [fixtureRoot], ocrPolicy: 'off', extractionTimeoutMs: 50_000 })).init();
    t.after(() => manager.close());
    return manager;
}

async function modelFor(manager, name) {
    const opened = await manager.open({ source: path.join(fixtureRoot, name), ocrPolicy: 'off' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    return { opened, state, model: state.model };
}

function assertValidBbox(bbox, page) {
    assert.ok(bbox);
    assert.ok(bbox.width > 0 && bbox.height > 0);
    assert.ok(bbox.x >= 0 && bbox.y >= 0);
    assert.ok(bbox.x + bbox.width <= page.width + 0.001);
    assert.ok(bbox.y + bbox.height <= page.height + 0.001);
}

test('real extraction preserves text and rotated displayed-page geometry', async t => {
    const manager = await managerFor(t);
    for (const name of ['text-layout.pdf', 'rotated.pdf']) {
        const { opened, state, model } = await modelFor(manager, name);
        for (const block of model.elements.filter(element => element.type === 'block')) {
            const page = state.indexes.pages.get(block.page);
            assertValidBbox(block.bbox, page);
            assert.deepEqual(block.citation.bbox, block.bbox);
        }
        if (name === 'rotated.pdf') assert.deepEqual(model.pages.map(page => page.rotation), [90, 270]);
        await manager.closeDocument(opened);
    }
});

test('real links retain typed text, geometry, and structured destinations', async t => {
    const manager = await managerFor(t);
    const { opened, state, model } = await modelFor(manager, 'links.pdf');
    const links = model.elements.filter(element => element.type === 'link');
    assert.equal(links.length, 4);
    assert.ok(links.every(link => link.text === null || typeof link.text === 'string'));
    assert.ok(links.every(link => LinkElementSchema.safeParse(link).success));
    assert.equal(links.find(link => link.destination?.kind === 'named').destination.name, 'ChapterTwo');
    const explicit = links.find(link => link.destination?.kind === 'explicit').destination;
    assert.equal(explicit.page, 2);
    assert.ok(Number.isFinite(explicit.x) && Number.isFinite(explicit.y));
    assert.ok(links.some(link => link.url && link.text === null));
    links.forEach(link => assertValidBbox(link.bbox, state.indexes.pages.get(link.page)));
    await manager.closeDocument(opened);
});

test('geometry fallback anchors are bounded, deterministic, and exclude unrelated spans', () => {
    const spans = [
        { str: 'First', bbox: { x: 10, y: 10, width: 30, height: 10 }, x: 10, yTop: 10, w: 30, h: 10 },
        { str: 'anchor', bbox: { x: 44, y: 10, width: 40, height: 10 }, x: 44, yTop: 10, w: 40, h: 10 },
        { str: 'Unrelated', bbox: { x: 200, y: 10, width: 60, height: 10 }, x: 200, yTop: 10, w: 60, h: 10 },
    ];
    const result = anchorLinkAnnotations(spans, [{ bbox: { x: 9, y: 9, width: 80, height: 12 }, url: 'https://example.com', destination: null, sourceId: 'one', subtype: 'Link', sourceIndex: 0 }]);
    assert.equal(result.links[0].text, 'First anchor');
    assert.ok(!result.links[0].text.includes('Unrelated'));
});

test('real adjacent, overlapping, and multiline links retain bounded visible anchors', async t => {
    const manager = await managerFor(t);
    const { opened, model } = await modelFor(manager, 'links-overlap.pdf');
    const links = model.elements.filter(element => element.type === 'link');
    assert.deepEqual(links.slice(0, 2).map(link => link.text), ['Adjacent one', 'Adjacent two']);
    assert.equal(links.find(link => link.url.endsWith('/multiline')).text, 'Multiline anchor first Multiline anchor second');
    const large = links.find(link => link.url.endsWith('/large'));
    assert.ok(!large.text.includes('Nearby unrelated text'));
    assert.ok(links.every(link => LinkElementSchema.safeParse(link).success));
    await manager.closeDocument(opened);
});

test('real annotations preserve subtype, contents, metadata, and geometry', async t => {
    const manager = await managerFor(t);
    const { opened, state, model } = await modelFor(manager, 'annotations.pdf');
    const annotations = model.elements.filter(element => element.type === 'annotation');
    assert.ok(annotations.length >= 4);
    assert.ok(new Set(annotations.map(value => value.subtype)).has('Highlight'));
    assert.ok(new Set(annotations.map(value => value.subtype)).has('FreeText'));
    assert.ok(annotations.some(value => value.text === 'Review note' && value.author === 'Alice'));
    assert.ok(annotations.some(value => value.modifiedAt?.startsWith('2025-01-03')));
    assert.ok(annotations.some(value => value.text === 'Reply note' && value.replyToSourceId));
    annotations.forEach(annotation => assertValidBbox(annotation.bbox, state.indexes.pages.get(annotation.page)));
    await manager.closeDocument(opened);
});

test('spatial tables are detected end to end and negative controls remain text', async t => {
    const manager = await managerFor(t);
    for (const name of ['tables-bordered.pdf', 'tables-borderless.pdf']) {
        const { opened, state, model } = await modelFor(manager, name);
        const table = model.elements.find(element => element.type === 'table');
        assert.ok(table);
        assert.equal(table.cells.length, 9);
        assert.ok(table.cells.every(cell => cell.bbox));
        assertValidBbox(table.bbox, state.indexes.pages.get(1));
        await manager.closeDocument(opened);
    }
    const negative = await modelFor(manager, 'table-negative-controls.pdf');
    assert.equal(negative.model.elements.some(element => element.type === 'table'), false);
    await manager.closeDocument(negative.opened);
});

test('raster and vector pages produce figures while clipping-only pages remain blank', async t => {
    const manager = await managerFor(t);
    for (const [name, visualType] of [['raster-photograph.pdf', 'raster'], ['vector-diagram.pdf', 'vector']]) {
        const { opened, state, model } = await modelFor(manager, name);
        assert.equal(model.pages[0].visualType, visualType);
        const figure = model.elements.find(element => element.type === 'figure');
        assert.ok(figure);
        assertValidBbox(figure.bbox, state.indexes.pages.get(1));
        const resource = await manager.readResource(figure.asset.uri);
        assert.ok(resource.blob);
        await manager.closeDocument(opened);
    }
    const clipping = await modelFor(manager, 'vector-clipping.pdf');
    assert.equal(clipping.model.pages[0].contentClass, 'blank');
    assert.equal(clipping.model.elements.length, 0);
    await manager.closeDocument(clipping.opened);
});

test('vector approximation remains bounded and mixed content survives uncertain analysis', async t => {
    const manager = await managerFor(t);
    const transformed = await modelFor(manager, 'vector-transformed.pdf');
    assert.equal(transformed.model.pages[0].visualType, 'vector');
    assert.equal(transformed.model.pages[0].visualSignals.vectorCoverage.precision, 'approximate');
    await manager.closeDocument(transformed.opened);

    const uncertain = await modelFor(manager, 'vector-unsupported.pdf');
    assert.equal(uncertain.model.pages[0].visualType, 'unknown');
    assert.equal(uncertain.model.pages[0].visualSignals.vectorCoverage.precision, 'unknown');
    assert.ok(uncertain.model.pages[0].warnings.some(warning => warning.code === 'visual_unknown'));
    assert.ok(uncertain.model.elements.some(element => element.type === 'figure' && element.figureKind === 'page_visual'));
    await manager.closeDocument(uncertain.opened);

    for (const [name, expected] of [['mixed-text-vector.pdf', 'block'], ['mixed-raster-vector.pdf', 'figure'], ['mixed-text-raster.pdf', 'figure']]) {
        const sample = await modelFor(manager, name);
        assert.ok(sample.model.elements.some(element => element.type === expected));
        await manager.closeDocument(sample.opened);
    }
});

test('independently positioned columns retain column-major deterministic order', async t => {
    const manager = await managerFor(t);
    const first = await modelFor(manager, 'multi-column.pdf');
    const texts = first.model.elements.filter(element => element.type === 'block').map(element => element.text);
    assert.equal(texts[0], 'LAYOUT HEADING');
    assert.ok(texts.findIndex(text => text.startsWith('Right column')) > texts.findLastIndex(text => text.startsWith('Left column')));
    assert.ok(texts.at(-1).startsWith('Spanning footer'));
    const firstOrder = first.model.elements.map(element => element.id);
    await manager.closeDocument(first.opened);
    const second = await modelFor(manager, 'multi-column.pdf');
    assert.deepEqual(second.model.elements.map(element => element.id), firstOrder);
    await manager.closeDocument(second.opened);
});

test('public parser code schema rejects arbitrary backend strings', () => {
    assert.equal(ParserErrorCodeSchema.safeParse('PDF_INVALID_XREF').success, true);
    assert.equal(ParserErrorCodeSchema.safeParse('backend said bad xref').success, false);
});
