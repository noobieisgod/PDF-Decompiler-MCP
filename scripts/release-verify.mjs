import fs from 'node:fs/promises';
import { run } from './lib/process.mjs';

const releaseTime = process.argv.includes('--release-time');
const authorized = process.env.PDF_DECOMPILER_PUBLICATION_AUTHORIZED === 'true';
const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));

if (releaseTime) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let available = false;
    try {
        await run(npmCommand, ['view', packageJson.name, 'name']);
    } catch (error) {
        if (/E404|404 Not Found/.test(`${error.stderr || ''}${error.message || ''}`)) available = true;
        else throw error;
    }
    if (!available) throw new Error(`The npm package name ${packageJson.name} is already registered. Stop and report the ownership conflict; do not select another name.`);
} else {
    console.log('Release-time npm name ownership check: pending by design.');
}

if (!authorized) console.log('Publication authorization: absent. No publish, release, push, or tag operation was performed.');
else console.log('Publication authorization variable is present, but this verification script never publishes.');
