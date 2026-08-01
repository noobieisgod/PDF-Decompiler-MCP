import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const output = path.resolve(process.argv[2] || 'artifacts/sbom.spdx.json');
const lockBytes = await fs.readFile('package-lock.json');
const lock = JSON.parse(lockBytes);
const packages = [];
for (const [location, metadata] of Object.entries(lock.packages)) {
    if (!location || !location.startsWith('node_modules/')) continue;
    const installed = await fs.readFile(path.join(location, 'package.json'), 'utf8').then(JSON.parse, () => null);
    if (!installed) continue;
    packages.push({
        SPDXID: `SPDXRef-Package-${packages.length + 1}`,
        name: installed.name,
        versionInfo: installed.version,
        downloadLocation: `https://registry.npmjs.org/${installed.name}/-/${installed.name.split('/').pop()}-${installed.version}.tgz`,
        filesAnalyzed: false,
        licenseConcluded: installed.license || metadata.license || 'NOASSERTION',
        licenseDeclared: installed.license || metadata.license || 'NOASSERTION',
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${encodeURIComponent(installed.name)}@${installed.version}` }],
    });
}
const document = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'pdf-decompiler-mcp-3.0.0',
    documentNamespace: `https://github.com/noobieisgod/PDF-Decompiler-MCP/sbom/${randomUUID()}`,
    creationInfo: { created: new Date().toISOString(), creators: ['Tool: scripts/generate-sbom.mjs'] },
    documentDescribes: packages.map(item => item.SPDXID),
    packages,
    annotations: [{ annotationDate: new Date().toISOString(), annotationType: 'OTHER', annotator: 'Tool: scripts/generate-sbom.mjs', comment: `package-lock.json sha256 ${createHash('sha256').update(lockBytes).digest('hex')}` }],
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(output);
