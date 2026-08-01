import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('legacy tool and executable are absent from active package metadata and server source', async () => {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    assert.deepEqual(Object.keys(packageJson.bin), ['pdf-decompiler-mcp']);
    assert.ok(!(await fs.readFile('src/server/create-server.mjs', 'utf8')).includes("registerTool('extract_pdf_content'"));
});
