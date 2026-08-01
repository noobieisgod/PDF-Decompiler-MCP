import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './lib/process.mjs';

const repository = path.resolve('.');
const output = path.resolve(process.argv[2] || path.join(repository, 'artifacts'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-package-'));
const stage = path.join(work, 'mcpb-stage');
const unpacked = path.join(work, 'mcpb-unpacked');
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const mcpbCli = path.join(repository, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
const npmEnvironment = { ...process.env, npm_config_cache: path.join(work, 'npm-cache') };

async function sha256(target) {
    return createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

async function copyRelative(relative) {
    const source = path.join(repository, relative);
    const destination = path.join(stage, relative);
    const stat = await fs.stat(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) await fs.cp(source, destination, { recursive: true });
    else await fs.copyFile(source, destination);
}

try {
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    const packed = JSON.parse((await run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', output], { cwd: repository, env: npmEnvironment })).stdout);
    const npmResult = packed[0];
    const npmTarball = path.join(output, npmResult.filename);
    const npmFiles = npmResult.files.map(file => file.path).sort();
    const prohibitedNpm = npmFiles.filter(file => /(?:^|\/)(?:test|node_modules|artifacts)(?:\/|$)|\.(?:pdf|zip|mcpb)$/i.test(file));
    if (prohibitedNpm.length) throw new Error(`Prohibited npm files: ${prohibitedNpm.join(', ')}`);

    await fs.mkdir(stage, { recursive: true });
    for (const file of npmFiles) await copyRelative(file);
    for (const file of ['package-lock.json', 'manifest.json', '.mcpbignore']) await copyRelative(file);
    await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: stage, timeout: 120_000, env: npmEnvironment });
    await run(process.execPath, [mcpbCli, 'validate', path.join(stage, 'manifest.json')], { cwd: repository });
    const mcpbFile = path.join(output, 'pdf-decompiler-mcp-3.0.0.mcpb');
    await run(process.execPath, [mcpbCli, 'pack', stage, mcpbFile], { cwd: repository, timeout: 120_000 });
    await run(process.execPath, [mcpbCli, 'unpack', mcpbFile, unpacked], { cwd: repository, timeout: 120_000 });
    const unpackedFiles = (await fs.readdir(unpacked, { recursive: true })).map(file => file.replaceAll('\\', '/'));
    for (const required of ['manifest.json', 'src/index.mjs', 'node_modules/@modelcontextprotocol/server/package.json', 'node_modules/mupdf/package.json']) {
        if (!unpackedFiles.includes(required)) throw new Error(`MCPB is missing ${required}`);
    }
    const prohibitedMcpb = unpackedFiles.filter(file => /(?:^|\/)(?:test|scripts|\.git)(?:\/|$)|\.(?:pdf|zip|tgz)$/i.test(file));
    if (prohibitedMcpb.length) throw new Error(`Prohibited MCPB files: ${prohibitedMcpb.join(', ')}`);

    const sbom = path.join(output, 'pdf-decompiler-mcp-3.0.0.spdx.json');
    await run(process.execPath, [path.join(repository, 'scripts', 'generate-sbom.mjs'), sbom], { cwd: stage });
    const artifacts = [npmTarball, mcpbFile, sbom];
    const checksums = [];
    for (const target of artifacts) checksums.push({ file: path.basename(target), sha256: await sha256(target), bytes: (await fs.stat(target)).size });
    await fs.writeFile(path.join(output, 'checksums.sha256'), `${checksums.map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`);
    const report = { output, npm: { filename: npmResult.filename, files: npmFiles.length, bytes: npmResult.size }, mcpb: { filename: path.basename(mcpbFile), files: unpackedFiles.length, manifestVersion: '0.4' }, sbom: { filename: path.basename(sbom) }, checksums };
    await fs.writeFile(path.join(output, 'package-inspection.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
} finally {
    await fs.rm(work, { recursive: true, force: true });
}
