import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import {
    CloseSchema,
    DocumentInfoSchema,
    EnvelopeSchema,
    GetElementSchema,
    GetPagesSchema,
    OpenSchema,
    RenderPageSchema,
    SearchSchema,
} from '../src/server/schemas.mjs';

const schemas = {
    'pdf_open.input': OpenSchema,
    'pdf_document_info.input': DocumentInfoSchema,
    'pdf_search.input': SearchSchema,
    'pdf_get_pages.input': GetPagesSchema,
    'pdf_get_element.input': GetElementSchema,
    'pdf_render_page.input': RenderPageSchema,
    'pdf_close.input': CloseSchema,
    'result-envelope': EnvelopeSchema,
};

await fs.mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
    const json = z.toJSONSchema(schema, { target: 'draft-7' });
    json.$id = `https://github.com/noobieisgod/PDF-Decompiler-MCP/schemas/${name}.schema.json`;
    await fs.writeFile(path.join('schemas', `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
}
