import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const required = [
    'README.md', 'docs/ARCHITECTURE.md', 'docs/PRIVACY.md', 'docs/CLIENT-COMPATIBILITY.md',
    'docs/BENCHMARKING.md', 'docs/CONFIGURATION.md', 'docs/TOOLS.md', 'docs/RELEASE.md',
    'SECURITY.md', 'ROADMAP.md', 'MIGRATION.md', 'CONTRIBUTING.md', 'SUPPORT.md',
    'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'NOTICE',
];
for (const file of required) await fs.access(file);

const markdown = (await fs.readdir('.', { recursive: true })).filter(name => name.endsWith('.md') && !name.startsWith('node_modules') && !name.startsWith('artifacts'));
const broken = [];
for (const file of markdown) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!link || /^(?:https?:|mailto:)/.test(link)) continue;
        const target = path.resolve(path.dirname(file), decodeURIComponent(link));
        if (!await fs.access(target).then(() => true, () => false)) broken.push(`${file}: ${match[1]}`);
    }
}
assert.deepEqual(broken, [], `Broken local documentation links:\n${broken.join('\n')}`);
console.log(`Documentation check passed for ${markdown.length} Markdown files.`);
