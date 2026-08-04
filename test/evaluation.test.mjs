import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openMupdfDocument } from '../src/backend/mupdf-runtime.mjs';

test('real-world evaluation manifest matches included PDFs and keeps TSMC download-only', async () => {
    const manifest = JSON.parse(await fs.readFile('evaluation/manifest.json', 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.samples.length, 3);
    for (const sample of manifest.samples.filter(item => item.distribution === 'included')) {
        const file = path.join('evaluation', sample.file);
        const bytes = await fs.readFile(file);
        assert.equal(bytes.length, sample.bytes, sample.id);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256, sample.id);
        assert.equal(openMupdfDocument(bytes).countPages(), sample.pages, sample.id);
    }
    const heavy = manifest.samples.find(item => item.id === 'heavy-test-one');
    assert.equal(heavy.distribution, 'download-only');
    assert.match(heavy.sourceUrl, /^https:\/\/investor\.tsmc\.com\//);
    assert.match(heavy.license, /no redistribution permission/i);
    assert.ok(!JSON.parse(await fs.readFile('package.json', 'utf8')).files.includes('evaluation'));
});
