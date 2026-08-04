import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('doctor validates a usable local configuration without starting stdio', async () => {
    const child = spawn(process.execPath, [path.resolve('src/index.mjs'), 'doctor', '--cache-mode', 'none', '--allow-root', process.cwd()], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /\[PASS\] node:/);
    assert.match(stdout, /\[PASS\] allow root:/);
    assert.match(stdout, /\[PASS\] startup:/);
    assert.match(stdout, /READY/);
});
