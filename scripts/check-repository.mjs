import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
assert.equal(packageJson.name, 'pdf-decompiler-mcp');
assert.equal(packageJson.version, '3.0.0');
assert.equal(packageJson.license, 'AGPL-3.0-only');
assert.equal(packageJson.engines.node, '^22.0.0 || ^24.0.0');
assert.deepEqual(Object.keys(packageJson.bin), ['pdf-decompiler-mcp']);

const files = await fs.readdir('.', { recursive: true });
const prohibited = files.filter(file => {
    const normalized = file.replaceAll('\\', '/');
    if (normalized === 'node_modules' || normalized.startsWith('node_modules/') || normalized === 'artifacts' || normalized.startsWith('artifacts/')) return false;
    return /(?:^|\/)(?:output|images)(?:\/|$)/.test(normalized)
        || /\.(?:zip|mcpb|dxt|tmp)$/i.test(normalized)
        || /(?:^|\/)node_modules(?:\/|$)/.test(normalized);
});
assert.deepEqual(prohibited, [], `Prohibited repository artifacts:\n${prohibited.join('\n')}`);

const activeFiles = files.filter(file => /\.(?:mjs|json|md|yml|yaml)$/i.test(file)
    && !file.startsWith('node_modules') && !file.startsWith('artifacts') && !['MIGRATION.md', 'CHANGELOG.md', 'docs/MIGRATION-INVENTORY.md'].includes(file.replaceAll('\\', '/')));
const staleBrand = [];
for (const file of activeFiles) {
    const source = await fs.readFile(file, 'utf8').catch(() => '');
    if (/Lightweight[ ]PDF|lightweight[-]pdf/i.test(source)) staleBrand.push(file);
}
assert.deepEqual(staleBrand, [], `Active legacy brand references:\n${staleBrand.join('\n')}`);
const runtimeFiles = activeFiles.filter(file => file === 'package.json' || file === 'manifest.json' || file.replaceAll('\\', '/').startsWith('src/'));
const staleSurface = [];
for (const file of runtimeFiles) {
    const source = await fs.readFile(file, 'utf8').catch(() => '');
    if (/pdf[-]extract[-]addon|extract[_]pdf[_]content/i.test(source)) staleSurface.push(file);
}
assert.deepEqual(staleSurface, [], `Active legacy runtime surfaces:\n${staleSurface.join('\n')}`);
console.log(`Repository check passed for ${files.length} paths.`);
