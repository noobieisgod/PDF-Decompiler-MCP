import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateFixtures } from '../test/fixtures/generate-fixtures.mjs';

const root = path.resolve('test/fixtures/generated');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'fixtures.manifest.json'), 'utf8'));
if (manifest.version !== 2 || manifest.license !== 'CC0-1.0') throw new Error('Fixture manifest version or license is invalid');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-fixtures-'));
try {
    await generateFixtures(temporary);
    for (const [name, expected] of Object.entries(manifest.fixtures)) {
        const current = await fs.readFile(path.join(root, name));
        const regenerated = await fs.readFile(path.join(temporary, name));
        const digest = value => createHash('sha256').update(value).digest('hex');
        if (digest(current) !== expected.sha256 || digest(regenerated) !== expected.sha256) throw new Error(`Fixture is not deterministic: ${name}`);
        if (expected.packageAllowed !== false || expected.generated !== true || !expected.purpose || !expected.expected || typeof expected.expected.errorCode === 'undefined') throw new Error(`Fixture metadata is incomplete: ${name}`);
    }
    for (const localName of manifest.localOnlyExcluded) {
        if (manifest.fixtures[localName]) throw new Error(`Local-only PDF is listed as generated: ${localName}`);
    }
} finally {
    await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`verified ${Object.keys(manifest.fixtures).length} deterministic fixtures`);
