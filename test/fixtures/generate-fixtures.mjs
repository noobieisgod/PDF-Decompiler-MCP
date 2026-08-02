import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

function pdfEscape(value) {
    return String(value).replace(/([\\()])/g, '\\$1').replace(/[^\x20-\x7e]/g, '?');
}

function streamObject(data, dictionary = '') {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return Buffer.concat([Buffer.from(`<< /Length ${bytes.length}${dictionary ? ` ${dictionary}` : ''} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
}

function serializePdf(objects, trailerExtra = '') {
    const chunks = [Buffer.from('%PDF-1.7\n% synthetic licensing-safe fixture\n')];
    const offsets = [0];
    let length = chunks[0].length;
    for (let index = 0; index < objects.length; index += 1) {
        offsets.push(length);
        const body = Buffer.isBuffer(objects[index]) ? objects[index] : Buffer.from(objects[index]);
        const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
        chunks.push(object);
        length += object.length;
    }
    const xrefOffset = length;
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra ? ` ${trailerExtra}` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref));
    return Buffer.concat(chunks);
}

function imageObject(image) {
    const compressed = deflateSync(image.data, { level: 9 });
    return streamObject(compressed, `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`);
}

function buildFixturePdf(pageSpecs, options = {}) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const reserve = () => { objects.push(''); return objects.length; };
    const add = body => { objects.push(body); return objects.length; };
    const fill = (id, body) => { objects[id - 1] = body; };
    const pageIds = pageSpecs.map(() => reserve());
    if (options.namedDestination && pageIds[1]) objects[0] = `<< /Type /Catalog /Pages 2 0 R /Dests << /${options.namedDestination} [${pageIds[1]} 0 R /XYZ 72 720 1] >> >>`;
    for (let pageIndex = 0; pageIndex < pageSpecs.length; pageIndex += 1) {
        const spec = pageSpecs[pageIndex];
        const imageRefs = [];
        for (const [index, image] of (spec.images || []).entries()) imageRefs.push({ name: image.name || `Im${index + 1}`, id: add(imageObject(image)), image });
        const content = [spec.graphics || ''];
        for (const text of spec.texts || []) content.push(`BT /F1 ${text.size || 12} Tf ${text.x || 0} ${text.y || 0} Td (${pdfEscape(text.text)}) Tj ET`);
        for (const ref of imageRefs) content.push(`q ${ref.image.drawWidth || ref.image.width} 0 0 ${ref.image.drawHeight || ref.image.height} ${ref.image.x || 0} ${ref.image.y || 0} cm /${ref.name} Do Q`);
        const contentId = add(streamObject(content.filter(Boolean).join('\n')));
        const annotationIds = (spec.annotations || []).map(annotation => reserve());
        for (let index = 0; index < annotationIds.length; index += 1) {
            const annotation = spec.annotations[index];
            fill(annotationIds[index], typeof annotation === 'function' ? annotation({ pageIds, annotationIds }) : annotation);
        }
        const xObjects = imageRefs.length ? ` /XObject << ${imageRefs.map(ref => `/${ref.name} ${ref.id} 0 R`).join(' ')} >>` : '';
        const annots = annotationIds.length ? ` /Annots [${annotationIds.map(id => `${id} 0 R`).join(' ')}]` : '';
        fill(pageIds[pageIndex], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${spec.width || 612} ${spec.height || 792}] /Rotate ${spec.rotate || 0} /Resources << /Font << /F1 3 0 R >>${xObjects} >> /Contents ${contentId} 0 R${annots} >>`);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    return serializePdf(objects);
}

export function buildSyntheticPdf({ pages = ['Synthetic PDF fixture'], rotate = 0, link = false, visualOnly = false } = {}) {
    return buildFixturePdf(pages.map(text => ({
        rotate,
        graphics: visualOnly ? '0.1 0.4 0.8 rg 72 300 450 300 re f 1 1 1 rg 100 400 300 80 re f' : '0 0 0 RG 70 650 460 90 re S',
        texts: visualOnly ? [] : [
            { x: 72, y: 720, size: 14, text },
            { x: 72, y: 702, size: 14, text: 'Row A 100 200' },
            { x: 72, y: 684, size: 14, text: 'Row B 300 400' },
        ],
        annotations: link ? ['<< /Type /Annot /Subtype /Link /Rect [72 710 260 735] /Border [0 0 0] /A << /S /URI /URI (https://example.com/evidence) >> /Contents (Synthetic link annotation) >>'] : [],
    })));
}

function tablePage({ bordered = true, merged = false } = {}) {
    const xs = [72, 240, 390];
    const ys = [680, 640, 600];
    const values = merged
        ? [['ANNUAL RESULTS', '', ''], ['Quarter', 'Revenue', 'Cost'], ['Q1', '100', '80']]
        : [['Quarter', 'Revenue', 'Cost'], ['Q1', '100', '80'], ['Q2', '120', '90']];
    const texts = values.flatMap((row, r) => row.map((text, c) => text ? { x: xs[c], y: ys[r], size: r === 0 ? 13 : 12, text } : null).filter(Boolean));
    const graphics = bordered ? `${[570, 610, 650, 690].map(y => `60 ${y} m 540 ${y} l S`).join(' ')} ${[60, 220, 370, 540].map(x => `${x} 570 m ${x} 690 l S`).join(' ')}` : '';
    return { texts, graphics };
}

function textualTablePage() {
    return { texts: [
        { x: 72, y: 700, size: 13, text: 'Datatype' }, { x: 240, y: 700, size: 13, text: 'Purpose' }, { x: 430, y: 700, size: 13, text: 'Examples' },
        { x: 72, y: 670, text: 'integer' }, { x: 240, y: 670, text: 'Holds a whole value' }, { x: 430, y: 670, text: 'one two five' },
        { x: 72, y: 640, text: 'decimal' }, { x: 240, y: 640, text: 'Holds a precise value' }, { x: 430, y: 640, text: 'two point five' },
        { x: 240, y: 625, text: 'with a wrapped explanation' }, { x: 430, y: 625, text: 'another example' },
        { x: 72, y: 595, text: 'string' }, { x: 240, y: 595, text: 'Holds readable text' }, { x: 430, y: 595, text: 'sample words' },
    ] };
}

function wideSpreadTablesPage() {
    const table = offset => [
        ['Item', 'Current', 'Prior'], ['Revenue', '120', '100'], ['Cost', '80', '70'], ['Income', '40', '30'],
    ].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({ x: offset + [0, 190, 300][columnIndex], y: 690 - rowIndex * 30, text })));
    return { width: 1200, texts: [...table(60), ...table(660)] };
}

function sectionedColumnsPage() {
    const rows = (prefix, y, leftStart, rightStart) => [0, 1, 2, 3].flatMap(index => [
        { x: 90, y: y - index * 18, size: 10, text: `${prefix}.${index + 1} Left section ${leftStart + index}` },
        { x: 330, y: y - index * 18, size: 10, text: `${prefix}.${index + 5} Right section ${rightStart + index}` },
    ]);
    return { texts: [
        { x: 90, y: 730, size: 18, text: 'THIRD SECTION' }, { x: 540, y: 730, size: 10, text: '040' },
        ...rows('3', 700, 1, 5),
        { x: 90, y: 590, size: 18, text: 'FOURTH SECTION' }, { x: 540, y: 590, size: 10, text: '068' },
        ...rows('4', 560, 1, 5),
    ] };
}

const FONT = {
    A:'011101000110001111111000110001',B:'11110100011000111110100011000111110',C:'01111100001000010000100001000001111',D:'11110100011000110001100011000111110',E:'11111100001000011110100001000011111',F:'11111100001000011110100001000010000',G:'01111100001000010111100011000101111',H:'10001100011000111111100011000110001',I:'11111001000010000100001000010011111',J:'00111000100001000010100100100101100',K:'10001100101010011000101001001010001',L:'10000100001000010000100001000011111',M:'10001110111010110101100011000110001',N:'10001110011010110011100011000110001',O:'01110100011000110001100011000101110',P:'11110100011000111110100001000010000',Q:'01110100011000110001101011001001101',R:'11110100011000111110101001001010001',S:'01111100001000001110000010000111110',T:'11111001000010000100001000010000100',U:'10001100011000110001100011000101110',V:'10001100011000110001100010101000100',W:'10001100011000110101101011010101010',X:'10001100010101000100010101000110001',Y:'10001100010101000100001000010000100',Z:'11111000010001000100010001000011111',
};

function rasterText(lines, { width = 600, height = 800, scale = 7, noisy = false } = {}) {
    const data = Buffer.alloc(width * height * 3, 255);
    const pixel = (x, y, value = 0) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const offset = (y * width + x) * 3;
        data[offset] = value; data[offset + 1] = value; data[offset + 2] = value;
    };
    lines.forEach((line, lineIndex) => {
        let cursor = 35;
        for (const character of line.toUpperCase()) {
            const glyph = FONT[character];
            if (glyph) {
                for (let row = 0; row < 7; row += 1) for (let col = 0; col < 5; col += 1) if (glyph[row * 5 + col] === '1') {
                    for (let yy = 0; yy < scale; yy += 1) for (let xx = 0; xx < scale; xx += 1) pixel(cursor + col * scale + xx, 80 + lineIndex * scale * 11 + row * scale + yy);
                }
            }
            cursor += scale * 6;
        }
    });
    if (noisy) for (let y = 0; y < height; y += 5) for (let x = (y * 17) % 23; x < width; x += 29) pixel(x, y, 60);
    return { width, height, data };
}

function readableRasterText(lines) {
    GlobalFonts.registerFromPath(path.resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'), 'FixtureSans');
    const width = 1200;
    const height = 1600;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.font = '72px FixtureSans';
    lines.forEach((line, index) => context.fillText(line, 80, 220 + index * 150));
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = Buffer.alloc(width * height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
        data[target] = rgba[source];
        data[target + 1] = rgba[source + 1];
        data[target + 2] = rgba[source + 2];
    }
    return { width, height, data };
}

function photographRaster() {
    const width = 96;
    const height = 64;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        data[offset] = Math.round(255 * x / width);
        data[offset + 1] = Math.round(255 * y / height);
        data[offset + 2] = (x * 13 + y * 7) % 256;
    }
    return { width, height, data };
}

function layoutFixtures() {
    const heading = { x: 72, y: 730, size: 18, text: 'LAYOUT HEADING' };
    return {
        'text-layout.pdf': buildFixturePdf([{ texts: [heading, { x: 72, y: 690, text: 'Ordinary paragraph geometry.' }, { x: 72, y: 650, text: '- List item geometry' }] }]),
        'narrow-layout.pdf': buildFixturePdf([{ width: 280, texts: [heading, { x: 30, y: 680, text: 'Narrow wrapped first line' }, { x: 30, y: 660, text: 'Narrow wrapped second line' }] }]),
        'wide-layout.pdf': buildFixturePdf([{ width: 1000, texts: [heading, { x: 80, y: 680, text: 'Wide left region' }, { x: 650, y: 680, text: 'Wide right region' }] }]),
        'multi-column.pdf': buildFixturePdf([{ texts: [heading, ...[680,650,620,590,560,530,500,470].flatMap((y,i)=>[{x:72,y,text:`Left column ${['alpha','beta','gamma','delta','epsilon','zeta','eta','theta'][i]}`},{x:330,y,text:`Right column ${['one','two','three','four','five','six','seven','eight'][i]}`}]), { x: 72, y: 430, size: 13, text: 'Spanning footer across both columns with deterministic text reaching far margin' }] }]),
        'layout-sidebar.pdf': buildFixturePdf([{ texts: [heading, ...[680,650,620].map((y,i)=>({x:72,y,text:`Main report ${['alpha','beta','gamma'][i]}`})), ...[680,650,620].map((y,i)=>({x:440,y,text:`Sidebar ${['note','detail','aside'][i]}`}))] }]),
        'layout-code.pdf': buildFixturePdf([{ texts: [heading, {x:72,y:680,text:'function example() {'},{x:100,y:660,text:'return deterministic;'},{x:72,y:640,text:'}'}] }]),
        'semantic-blocks.pdf': buildFixturePdf([{ texts: [
            {x:72,y:740,size:24,text:'PRIMARY HEADING'},
            {x:72,y:700,size:18,text:'SECONDARY HEADING'},
            {x:72,y:660,text:'1. Ordered first item'},
            {x:96,y:630,text:'- Nested unordered item'},
            {x:72,y:600,text:'4. Ordered restart item'},
            {x:96,y:578,text:'Continuation paragraph for ordered item'},
            {x:72,y:510,text:'function fencedExample() {'},
            {x:92,y:498,text:'return `nested`;'},
            {x:72,y:486,text:'}'},
        ] }]),
        'layout-ambiguous.pdf': buildFixturePdf([{ texts: [{x:72,y:700,text:'Ambiguous left top'},{x:330,y:680,text:'Ambiguous right offset'},{x:72,y:640,text:'Ambiguous left bottom'}] }]),
    };
}

function linkFixtures() {
    const external = '<< /Type /Annot /Subtype /Link /Rect [72 700 190 725] /Border [0 0 0] /A << /S /URI /URI (https://example.com/visible) >> /Contents (External evidence) >>';
    const targetOnly = '<< /Type /Annot /Subtype /Link /Rect [450 700 520 725] /Border [0 0 0] /A << /S /URI /URI (https://example.com/target-only) >> >>';
    return {
        'links.pdf': buildFixturePdf([
            { texts: [{x:72,y:710,text:'Visible anchor'},{x:250,y:710,text:'Internal named'},{x:72,y:650,text:'Explicit destination'}], annotations: [external, targetOnly, '<< /Type /Annot /Subtype /Link /Rect [250 700 360 725] /Dest /ChapterTwo /Border [0 0 0] >>', ({pageIds})=>`<< /Type /Annot /Subtype /Link /Rect [72 640 210 665] /Dest [${pageIds[1]} 0 R /XYZ 72 700 1] /Border [0 0 0] >>`] },
            { texts: [{x:72,y:700,text:'Destination page'}] },
        ], { namedDestination: 'ChapterTwo' }),
        'links-overlap.pdf': buildFixturePdf([{ texts: [
            {x:72,y:710,text:'Adjacent one'},{x:180,y:710,text:'Adjacent two'},
            {x:72,y:650,text:'Multiline anchor first'},{x:72,y:630,text:'Multiline anchor second'},
            {x:350,y:650,text:'Nearby unrelated text'},
        ], annotations: [
            '<< /Type /Annot /Subtype /Link /Rect [72 700 165 725] /A << /S /URI /URI (https://example.com/one) >> >>',
            '<< /Type /Annot /Subtype /Link /Rect [175 700 280 725] /A << /S /URI /URI (https://example.com/two) >> >>',
            '<< /Type /Annot /Subtype /Link /Rect [70 620 240 665] /A << /S /URI /URI (https://example.com/multiline) >> >>',
            '<< /Type /Annot /Subtype /Link /Rect [60 600 300 680] /A << /S /URI /URI (https://example.com/large) >> >>',
        ] }]),
    };
}

function annotationFixture() {
    return buildFixturePdf([{ texts: [{x:72,y:710,text:'Annotated visible content'}], annotations: [
        '<< /Type /Annot /Subtype /Text /Rect [72 650 96 674] /Contents (Review note) /T (Alice) /CreationDate (D:20250102030405Z) /M (D:20250103040506Z) /C [1 1 0] /F 4 >>',
        '<< /Type /Annot /Subtype /Highlight /Rect [72 695 230 725] /QuadPoints [72 725 230 725 72 695 230 695] /Contents (Important highlight) /T (Bob) /C [1 0 0] >>',
        '<< /Type /Annot /Subtype /FreeText /Rect [300 620 500 680] /Contents (Free text annotation) /T (Carol) /C [0 0 1] >>',
        '<< /Type /Annot /Subtype /Underline /Rect [72 580 230 610] /QuadPoints [72 610 230 610 72 580 230 580] /Contents (Underline annotation) /T (Dana) >>',
        ({annotationIds}) => `<< /Type /Annot /Subtype /Text /Rect [110 650 134 674] /Contents (Reply note) /T (Eve) /IRT ${annotationIds[0]} 0 R /RT /R >>`,
    ] }]);
}

function uncertainVectorFixture() {
    return serializePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Shading << /Sh1 5 0 R >> >> /Contents 4 0 R >>',
        streamObject('/Sh1 sh'),
        '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 612 792] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>',
    ]);
}

function visualFixtures() {
    const photo = photographRaster();
    const readable = readableRasterText(['OCR SUCCESS TEXT FOR LOCAL WINDOWS', 'DETERMINISTIC EVIDENCE WITH SPATIAL GEOMETRY']);
    const unreadable = rasterText(['OCR FAILURE NOISE'], { noisy: true });
    return {
        'raster-photograph.pdf': buildFixturePdf([{ images: [{...photo,name:'Photo',x:90,y:280,drawWidth:430,drawHeight:300}] }]),
        'image-only.pdf': buildFixturePdf([{ images: [{...photo,name:'Image',x:0,y:0,drawWidth:612,drawHeight:792}] }]),
        'scan-readable.pdf': buildFixturePdf([{ images: [{...readable,name:'Scan',x:0,y:0,drawWidth:612,drawHeight:792}] }]),
        'image-ocr.pdf': buildFixturePdf([{ texts: [{x:72,y:740,text:'Native image OCR heading'}], images: [{...readable,name:'OcrRegion',x:90,y:260,drawWidth:430,drawHeight:430}] }]),
        'multiple-image-ocr.pdf': buildFixturePdf([{ texts: [{x:72,y:740,text:'Two OCR regions'}], images: [
            {...readable,name:'OcrRegionOne',x:40,y:400,drawWidth:250,drawHeight:300},
            {...rasterText(['SECOND OCR REGION TEXT'], { width: 600, height: 800, scale: 7 }),name:'OcrRegionTwo',x:320,y:400,drawWidth:250,drawHeight:300},
        ] }]),
        'scan-unreadable.pdf': buildFixturePdf([{ images: [{...unreadable,name:'Scan',x:0,y:0,drawWidth:612,drawHeight:792}] }]),
        'vector-diagram.pdf': buildFixturePdf([{ graphics: '0.1 0.4 0.8 rg 72 300 450 300 re f 0 0 0 RG 72 300 m 522 600 l S' }]),
        'vector-transformed.pdf': buildFixturePdf([{ graphics: 'q 0.8 0.2 -0.2 0.8 120 100 cm 0.7 0.2 0.1 rg 50 200 300 180 re f Q' }]),
        'vector-clipping.pdf': buildFixturePdf([{ graphics: '0 0 612 792 re W n 1 1 1 rg 0 0 612 792 re f' }]),
        'vector-unsupported.pdf': uncertainVectorFixture(),
        'mixed-text-vector.pdf': buildFixturePdf([{ texts: [{x:72,y:720,text:'Mixed vector text'}], graphics: '0.2 0.7 0.3 rg 72 300 300 250 re f' }]),
        'mixed-raster-vector.pdf': buildFixturePdf([{ images: [{...photo,name:'Photo',x:72,y:300,drawWidth:250,drawHeight:200}], graphics: '0.8 0.2 0.2 rg 360 300 160 200 re f' }]),
        'mixed-text-raster.pdf': buildFixturePdf([{ texts: [{x:72,y:720,text:'Mixed raster text'}], images: [{...photo,name:'Photo',x:72,y:300,drawWidth:430,drawHeight:300}] }]),
        'blank.pdf': buildFixturePdf([{}]),
    };
}

function expectedFixtureBehavior(name) {
    const malformedCodes = {
        'invalid-signature.pdf': 'PDF_INVALID_SIGNATURE',
        'truncated.pdf': 'PDF_TRUNCATED',
        'invalid-xref.pdf': 'PDF_INVALID_XREF',
        'missing-startxref.pdf': 'PDF_INVALID_STARTXREF',
        'malformed.pdf': 'PDF_MALFORMED_UNKNOWN',
        'encrypted.pdf': 'PDF_PASSWORD_REQUIRED',
    };
    if (malformedCodes[name]) return { pageClassifications: [], visualTypes: [], elementTypes: [], boundingBoxesRequired: false, warnings: [], errorCode: malformedCodes[name] };
    const result = {
        pageClassifications: ['text', 'dense_text'], visualTypes: ['none', 'vector'], elementTypes: ['block'],
        boundingBoxesRequired: true, bboxContract: { coordinateSpace: 'displayed_page_points', tolerancePt: 1, withinPage: true },
        warnings: name === 'layout-ambiguous.pdf' ? ['layout_ambiguous'] : [], errorCode: null,
    };
    if (name === 'blank.pdf') Object.assign(result, { pageClassifications: ['blank'], visualTypes: ['none'], elementTypes: [], boundingBoxesRequired: false });
    if (name.startsWith('scan-') || name === 'scanned-proxy.pdf' || name === 'image-only.pdf') Object.assign(result, {
        pageClassifications: ['scan_like', 'ocr_text'], visualTypes: ['raster'], elementTypes: ['figure', 'block'], warnings: ['ocr_unavailable_or_rejected'],
        ocrText: ['scan-readable.pdf', 'image-ocr.pdf', 'multiple-image-ocr.pdf'].includes(name) ? 'OCR SUCCESS TEXT' : null,
    });
    if (name.startsWith('vector-')) Object.assign(result, {
        pageClassifications: ['visual'], visualTypes: name === 'vector-unsupported.pdf' ? ['unknown'] : ['vector'],
        elementTypes: ['figure'], warnings: name === 'vector-unsupported.pdf' ? ['visual_unknown'] : ['visual_bounds_may_be_approximate'],
    });
    if (name.includes('raster') || name.includes('photograph') || name.includes('repeated')) Object.assign(result, { pageClassifications: ['visual', 'text'], visualTypes: ['raster', 'mixed'], elementTypes: ['figure'] });
    if (name.startsWith('table') || name === 'tables.pdf') Object.assign(result, {
        pageClassifications: name.includes('negative') ? ['text'] : ['table'], visualTypes: ['none', 'vector'],
        elementTypes: name.includes('negative') ? ['block'] : ['table'], tableShape: name.includes('negative') ? null : { rows: 3, columns: 3 },
    });
    if (name === 'table-textual-wrapped.pdf') result.tableShape = { minimumRows: 4, columns: 3, tableCount: 1 };
    if (name === 'table-wide-spread.pdf') result.tableShape = { rows: 4, columns: 3, tableCount: 2 };
    if (name.startsWith('links')) Object.assign(result, {
        pageClassifications: ['text'], elementTypes: ['block', 'link'], warnings: ['incomplete_or_ambiguous_links_when_present'],
        linkTargets: name === 'links.pdf' ? ['external_url', 'named_destination', 'explicit_destination', 'target_only'] : ['adjacent', 'overlapping', 'multiline'],
    });
    if (name === 'annotations.pdf') Object.assign(result, { pageClassifications: ['text'], elementTypes: ['block', 'annotation'], annotationSubtypes: ['Text', 'Highlight', 'FreeText', 'Underline'], annotationCount: 5 });
    if (name === 'text-layout.pdf') result.bboxSamples = [{ type: 'block', text: 'LAYOUT HEADING', x: 72, y: 44, width: 159.03, height: 18 }];
    if (name === 'raster-photograph.pdf') result.bboxSamples = [{ type: 'figure', x: 90, y: 212, width: 430, height: 300 }];
    if (name === 'rotated.pdf') result.rotations = [90, 270];
    if (name === 'multi-column.pdf') result.readingOrder = ['LAYOUT HEADING', 'Left column', 'Right column', 'Spanning footer'];
    if (name === 'toc-sectioned-columns.pdf') result.readingOrder = ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8'];
    return result;
}

export async function generateFixtures(directory = fileURLToPath(new URL('./generated', import.meta.url))) {
    await fs.mkdir(directory, { recursive: true });
    const fixtures = {
        ...layoutFixtures(),
        'tables-bordered.pdf': buildFixturePdf([tablePage({ bordered: true })]),
        'tables-borderless.pdf': buildFixturePdf([tablePage({ bordered: false })]),
        'table-merged-header.pdf': buildFixturePdf([tablePage({ bordered: true, merged: true })]),
        'table-negative-controls.pdf': buildFixturePdf([{ texts: [{x:72,y:700,text:'Chapter one ........ 10'},{x:72,y:670,text:'const value = 100'},{x:72,y:640,text:'Ordinary aligned prose'}] }]),
        'table-textual-wrapped.pdf': buildFixturePdf([textualTablePage()]),
        'table-wide-spread.pdf': buildFixturePdf([wideSpreadTablesPage()]),
        'toc-sectioned-columns.pdf': buildFixturePdf([sectionedColumnsPage()]),
        ...visualFixtures(),
        ...linkFixtures(),
        'annotations.pdf': annotationFixture(),
        'rotated.pdf': buildFixturePdf([{ rotate: 90, texts: [{x:72,y:720,text:'Rotated ninety evidence'}] }, { rotate: 270, texts: [{x:72,y:720,text:'Rotated two seventy'}] }]),
        'repeated-images.pdf': (() => { const photo = photographRaster(); const variant = {...photo,data:Buffer.from(photo.data)}; variant.data[0] ^= 255; return buildFixturePdf([{images:[{...photo,name:'Same',x:72,y:400,drawWidth:220,drawHeight:150}]},{images:[{...photo,name:'Same',x:72,y:400,drawWidth:220,drawHeight:150}]},{images:[{...variant,name:'Variant',x:72,y:400,drawWidth:220,drawHeight:150}]}]); })(),
        'oversized-content.pdf': buildFixturePdf(Array.from({length:4},(_,page)=>({ texts: Array.from({length:55},(_,index)=>({x:40,y:760-index*13,size:9,text:`Visible oversized record ${page*55+index} ${'X'.repeat(70)}`})) }))),
        'text.pdf': buildSyntheticPdf({ pages: ['Heading Alpha deterministic retrieval'] }),
        'tables.pdf': buildFixturePdf([tablePage({ bordered: true })]),
        'links-annotations.pdf': linkFixtures()['links.pdf'],
        'repeated-graphics.pdf': (() => { const photo = photographRaster(); return buildFixturePdf([{images:[{...photo,x:72,y:400,drawWidth:220,drawHeight:150}]},{images:[{...photo,x:72,y:400,drawWidth:220,drawHeight:150}]}]); })(),
        'photograph-proxy.pdf': visualFixtures()['raster-photograph.pdf'],
        'scanned-proxy.pdf': visualFixtures()['scan-readable.pdf'],
        ...visualFixtures(),
    };
    fixtures['invalid-signature.pdf'] = Buffer.from('not a pdf');
    fixtures['truncated.pdf'] = fixtures['text-layout.pdf'].subarray(0, Math.floor(fixtures['text-layout.pdf'].length * 0.7));
    fixtures['invalid-xref.pdf'] = Buffer.from(fixtures['text-layout.pdf'].toString('binary').replace(/(xref\n0 \d+\n)\d{10} \d{5} f /, '$1BAD XREF ENTRY'), 'binary');
    fixtures['missing-startxref.pdf'] = Buffer.from(fixtures['text-layout.pdf'].toString('binary').replace(/startxref\n\d+/, 'startxref\n999999'), 'binary');
    fixtures['malformed.pdf'] = serializePdf(['<< /Type /Catalog >>']);
    const owner = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    const user = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
    const identifier = '0123456789abcdef0123456789abcdef';
    fixtures['encrypted.pdf'] = serializePdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
        streamObject(''),
        `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner}> /U <${user}> /P -4 >>`,
    ], `/Encrypt 5 0 R /ID [<${identifier}><${identifier}>]`);
    for (const [name, bytes] of Object.entries(fixtures)) await fs.writeFile(path.join(directory, name), bytes);
    const manifest = {
        version: 2,
        generator: 'test/fixtures/generate-fixtures.mjs',
        ownership: 'Project-generated synthetic content',
        license: 'CC0-1.0',
        fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a],[b])=>a.localeCompare(b)).map(([name, bytes]) => [name, {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            generated: true,
            packageAllowed: false,
            purpose: name.replace(/\.pdf$/, '').replaceAll('-', ' '),
            ocrRequired: ['scan-readable.pdf', 'image-ocr.pdf', 'multiple-image-ocr.pdf'].includes(name),
            expected: expectedFixtureBehavior(name),
        }])),
        localOnlyExcluded: ['Heavy Test One.pdf', 'Medium Test One.pdf', 'Medium Test Two.pdf'],
    };
    await fs.writeFile(path.join(directory, 'fixtures.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(directory, 'LICENSE.json'), `${JSON.stringify({ license: 'CC0-1.0', generator: manifest.generator, manifest: 'fixtures.manifest.json', localOnlyExcluded: manifest.localOnlyExcluded }, null, 2)}\n`);
    return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateFixtures();
