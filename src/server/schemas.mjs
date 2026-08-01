import { z } from 'zod/v4';

const DocumentId = z.string().regex(/^doc_[a-f0-9]{64}$/);
const ExtractionFingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const PageInterval = z.object({
    start: z.number().int().min(1).optional(),
    end: z.number().int().min(1).optional(),
});
const BoundingBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const DocumentReference = {
    documentId: DocumentId.describe('Identifier derived from the exact PDF bytes.'),
    extractionFingerprint: ExtractionFingerprint.describe('Exact extraction generation to resolve.'),
};

export const BudgetSchema = z.object({
    estimatedTokens: z.number().int().min(0).optional(),
    responseBytes: z.number().int().min(0).optional(),
    pages: z.number().int().min(0).optional(),
    textBlocks: z.number().int().min(0).optional(),
    tables: z.number().int().min(0).optional(),
    figures: z.number().int().min(0).optional(),
    renderedPages: z.number().int().min(0).optional(),
    imageDimension: z.number().int().min(0).optional(),
}).optional();

export const OpenSchema = z.object({
    source: z.string().min(1).optional().describe('HTTPS URL or local PDF path permitted by the configured local-file policy.'),
    pages: z.array(PageInterval).min(1).optional(),
    maxImageDimension: z.number().int().min(64).max(4096).optional(),
    refresh: z.boolean().optional(),
    ocrPolicy: z.enum(['auto', 'off', 'required']).optional(),
    cursor: z.string().min(1).optional(),
    documentId: DocumentId.optional(),
    extractionFingerprint: ExtractionFingerprint.optional(),
});

export const DocumentInfoSchema = z.object(DocumentReference);

export const SearchSchema = z.object({
    ...DocumentReference,
    query: z.string().min(1),
    strategy: z.enum(['full_text', 'semantic', 'hybrid']).optional(),
    pages: z.array(z.number().int().min(1)).optional(),
    elementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(),
    cursor: z.string().min(1).optional(),
    budget: BudgetSchema,
});

export const GetPagesSchema = z.object({
    ...DocumentReference,
    pages: z.array(z.number().int().min(1)).min(1).optional(),
    pageRanges: z.array(PageInterval).min(1).optional(),
    mode: z.enum(['text', 'balanced', 'fidelity']).optional(),
    includeElementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(),
    excludeElementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(),
    cursor: z.string().min(1).optional(),
    budget: BudgetSchema,
});

export const GetElementSchema = z.object({
    ...DocumentReference,
    elementId: z.string().min(1),
});

export const RenderPageSchema = z.object({
    ...DocumentReference,
    page: z.number().int().min(1),
    bbox: BoundingBox.optional(),
    format: z.enum(['auto', 'png', 'jpeg']).optional(),
    maxDimension: z.number().int().min(64).max(4096).optional(),
    imageDelivery: z.enum(['auto', 'resource', 'inline']).optional().describe('Auto conservatively returns a resource. Inline must be explicitly requested.'),
    budget: BudgetSchema,
});

export const CloseSchema = z.object({
    ...DocumentReference,
    deleteCache: z.boolean().optional(),
});

export const EnvelopeSchema = z.object({
    schemaVersion: z.literal('3.0.0'),
    operation: z.string(),
    documentId: DocumentId.nullable(),
    extractionFingerprint: ExtractionFingerprint.nullable(),
    data: z.json(),
    citations: z.array(z.json()),
    warnings: z.array(z.json()),
    diagnostics: z.json().nullable(),
    omissions: z.array(z.json()),
    budget: z.json().nullable(),
    nextCursor: z.string().nullable(),
});
