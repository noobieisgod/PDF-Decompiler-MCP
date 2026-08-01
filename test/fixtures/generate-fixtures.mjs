import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';

function pdfEscape(value) {
    return value.replace(/([\\()])/g, '\\$1').replace(/[^\x20-\x7e]/g, '?');
}

export function buildSyntheticPdf({ pages = ['Synthetic PDF fixture'], rotate = 0, link = false, visualOnly = false } = {}) {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const pageIds = [];
    for (let index = 0; index < pages.length; index += 1) {
        const pageId = objects.length + 1;
        const contentId = pageId + 1;
        const annotationId = link ? pageId + 2 : null;
        pageIds.push(pageId);
        const text = visualOnly ? '' : `BT /F1 14 Tf 72 720 Td 18 TL (${pdfEscape(pages[index])}) Tj T* (Row A 100 200) Tj T* (Row B 300 400) Tj ET`;
        const graphics = visualOnly ? '0.1 0.4 0.8 rg 72 300 450 300 re f 1 1 1 rg 100 400 300 80 re f' : '0 0 0 RG 70 650 460 90 re S';
        const stream = `${graphics}\n${text}\n`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R${annotationId ? ` /Annots [${annotationId} 0 R]` : ''} >>`);
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
        if (annotationId) objects.push('<< /Type /Annot /Subtype /Link /Rect [72 690 260 730] /Border [0 0 0] /A << /S /URI /URI (https://example.com/evidence) >> /Contents (Synthetic link annotation) >>');
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let output = '%PDF-1.7\n% synthetic licensing-safe fixture\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(output));
        output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(output);
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(output);
}

export async function generateFixtures(directory = fileURLToPath(new URL('./generated', import.meta.url))) {
    await fs.mkdir(directory, { recursive: true });
    const fixtures = {
        'text.pdf': buildSyntheticPdf({ pages: ['Heading Alpha deterministic retrieval'] }),
        'tables.pdf': buildSyntheticPdf({ pages: ['Quarter Revenue Cost Margin'] }),
        'links-annotations.pdf': buildSyntheticPdf({ pages: ['Linked evidence'], link: true }),
        'repeated-graphics.pdf': buildSyntheticPdf({ pages: ['Repeated graphic one', 'Repeated graphic two', 'Repeated graphic three'] }),
        'photograph-proxy.pdf': buildSyntheticPdf({ pages: ['Synthetic colored visual region'], visualOnly: true }),
        'scanned-proxy.pdf': buildSyntheticPdf({ pages: ['Synthetic scan proxy'], visualOnly: true }),
        'multi-column.pdf': buildSyntheticPdf({ pages: ['Left column text                         Right column text'] }),
        'rotated.pdf': buildSyntheticPdf({ pages: ['Rotated evidence'], rotate: 90 }),
        'oversized-content.pdf': buildSyntheticPdf({ pages: ['X'.repeat(10_000)] }),
    };
    for (const [name, bytes] of Object.entries(fixtures)) await fs.writeFile(path.join(directory, name), bytes);
    await fs.writeFile(path.join(directory, 'malformed.pdf'), Buffer.from('%PDF-1.7\nmalformed'));
    const encrypted = new mupdf.PDFDocument(fixtures['text.pdf']).saveToBuffer('compress,encrypt=aes-256,user-password=test,owner-password=owner').asUint8Array();
    await fs.writeFile(path.join(directory, 'encrypted.pdf'), encrypted);
    await fs.writeFile(path.join(directory, 'LICENSE.json'), `${JSON.stringify({
        license: 'CC0-1.0',
        generator: 'test/fixtures/generate-fixtures.mjs',
        provenance: 'Generated entirely from programmatic text and vector primitives; no third-party document content.',
    }, null, 2)}\n`);
    return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateFixtures();
