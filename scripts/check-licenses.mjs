import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const packages = [];
for (const [location, metadata] of Object.entries(lock.packages)) {
    if (!location || !location.startsWith('node_modules/')) continue;
    const packageFile = path.join(location, 'package.json');
    const installed = await fs.readFile(packageFile, 'utf8').then(JSON.parse, () => null);
    if (!installed) continue;
    const license = installed.license || metadata.license;
    assert.ok(license, `Missing dependency license: ${installed.name}`);
    packages.push({ name: installed.name, version: installed.version, license, native: filesNative(location) });
}

function filesNative(location) {
    return /(?:napi|canvas|mupdf)/i.test(location);
}

assert.equal(JSON.parse(await fs.readFile('test/fixtures/generated/LICENSE.json', 'utf8')).license, 'CC0-1.0');
const evaluation = JSON.parse(await fs.readFile('evaluation/manifest.json', 'utf8'));
assert.deepEqual(evaluation.samples.map(sample => [sample.id, sample.distribution, sample.license]), [
    ['medium-test-one', 'included', 'CC-BY-SA-4.0 with separately attributed components'],
    ['medium-test-two', 'included', 'CC-BY-4.0'],
    ['heavy-test-one', 'download-only', 'Copyright TSMC; no redistribution permission granted'],
]);
console.log(JSON.stringify({ checked: packages.length, packages }, null, 2));
