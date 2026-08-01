import { z } from 'zod/v4';

export const DocumentIdSchema = z.string().regex(/^doc_[a-f0-9]{64}$/);
export const ExtractionFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const SourceIdSchema = z.string().uuid();
const PageInterval = z.object({ start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() });
export const BoundingBoxSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
});
const LegacyBoundingBoxSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
const NullableBoundingBoxSchema = BoundingBoxSchema.nullable();

export const DocumentReference = {
    documentId: DocumentIdSchema.describe('Identifier derived from the exact PDF bytes.'),
    extractionFingerprint: ExtractionFingerprintSchema.describe('Exact extraction generation to resolve.'),
};

export const CitationSchema = z.object({
    documentId: DocumentIdSchema,
    extractionFingerprint: ExtractionFingerprintSchema,
    pageId: z.string().regex(/^page:\d+$/),
    elementId: z.string().min(1),
    bbox: NullableBoundingBoxSchema,
});

export const LinkDestinationSchema = z.object({
    kind: z.enum(['named', 'explicit', 'unresolved']),
    name: z.string().max(256).nullable(),
    page: z.number().int().positive().nullable(),
    x: z.number().finite().nullable(),
    y: z.number().finite().nullable(),
    zoom: z.number().finite().nonnegative().nullable(),
});

const Fingerprints = {
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    locationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const ElementBase = {
    id: z.string().min(1),
    page: z.number().int().positive(),
    readingOrder: z.number().int().nonnegative(),
    bbox: NullableBoundingBoxSchema,
    citation: CitationSchema,
    ...Fingerprints,
};

export const BlockElementSchema = z.object({
    ...ElementBase,
    type: z.literal('block'),
    role: z.enum(['heading', 'text', 'list', 'ocr']),
    text: z.string(),
    extractionMethod: z.string(),
    confidence: z.number().min(0).max(1),
});

const TableCellSchema = z.object({
    id: z.string().min(1),
    row: z.number().int().positive(),
    column: z.number().int().positive(),
    rowSpan: z.number().int().positive(),
    columnSpan: z.number().int().positive(),
    text: z.string(),
    bbox: NullableBoundingBoxSchema,
});

export const TableElementSchema = z.object({
    ...ElementBase,
    type: z.literal('table'),
    rows: z.array(z.array(z.string())),
    cells: z.array(TableCellSchema),
    text: z.string(),
});

export const AssetSchema = z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    documentId: DocumentIdSchema,
    extractionFingerprint: ExtractionFingerprintSchema,
    mimeType: z.string().min(1),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    deferredRender: z.object({ page: z.number().int().positive(), format: z.enum(['png', 'jpeg']), maxDimension: z.number().int().positive() }).nullable().optional(),
    uri: z.string().startsWith('pdf-decompiler://'),
});

export const FigureElementSchema = z.object({
    ...ElementBase,
    type: z.literal('figure'),
    figureKind: z.enum(['embedded_image', 'page_visual']),
    caption: z.string().nullable(),
    text: z.string().nullable(),
    asset: AssetSchema,
});

export const AnnotationElementSchema = z.object({
    ...ElementBase,
    type: z.literal('annotation'),
    subtype: z.string().min(1),
    text: z.string().nullable(),
    author: z.string().nullable(),
    createdAt: z.string().datetime().nullable(),
    modifiedAt: z.string().datetime().nullable(),
    color: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).nullable(),
    flags: z.object({ raw: z.number().int().nonnegative(), names: z.array(z.string()) }).nullable(),
    parentSourceId: z.string().nullable(),
    replyToSourceId: z.string().nullable(),
    supported: z.boolean(),
    provenance: z.object({ backend: z.literal('pdfjs'), sourceId: z.string().nullable(), sourceSubtype: z.string() }),
});

export const LinkElementSchema = z.object({
    ...ElementBase,
    type: z.literal('link'),
    text: z.string().nullable(),
    url: z.string().nullable(),
    destination: LinkDestinationSchema.nullable(),
    targetKind: z.enum(['external_url', 'internal_destination', 'unknown']),
    anchored: z.boolean(),
    annotationText: z.string().nullable(),
    anchorSource: z.enum(['overlaid_text', 'geometry_overlap', 'none']),
    provenance: z.object({ backend: z.literal('pdfjs'), source: z.literal('link_annotation'), sourceId: z.string().nullable(), subtype: z.string() }),
});

export const ElementSchema = z.discriminatedUnion('type', [BlockElementSchema, TableElementSchema, FigureElementSchema, AnnotationElementSchema, LinkElementSchema]);

export const VisualMeasurementSchema = z.object({ value: z.number().min(0).max(1).nullable(), precision: z.enum(['exact', 'approximate', 'unknown']) });
export const PageVisualSignalsSchema = z.object({
    hasText: z.boolean(),
    rasterCount: z.number().int().nonnegative(),
    rasterCoverage: VisualMeasurementSchema,
    vectorPaintCount: z.number().int().nonnegative().nullable(),
    vectorCoverage: VisualMeasurementSchema,
    annotationCount: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
});

export const SourceDescriptorSchema = z.object({
    sourceId: SourceIdSchema,
    sourceKind: z.enum(['local', 'https']),
    sourceLabel: z.string().max(128),
    basename: z.string().nullable(),
    host: z.string().nullable(),
    callerProvidedLabel: z.boolean(),
});

export const ParserErrorCodeSchema = z.enum([
    'PDF_INVALID_SIGNATURE', 'PDF_TRUNCATED', 'PDF_INVALID_XREF', 'PDF_INVALID_STARTXREF',
    'PDF_UNSUPPORTED_ENCRYPTION', 'PDF_PASSWORD_REQUIRED', 'PDF_DECOMPRESSION_LIMIT', 'PDF_PAGE_LIMIT',
    'PDF_PARSER_TIMEOUT', 'PDF_PARSER_CRASH', 'PDF_UNSUPPORTED_FEATURE', 'PDF_MALFORMED_UNKNOWN',
]);
const ParserCategorySchema = z.enum([
    'invalid_pdf_signature', 'truncated_document', 'invalid_cross_reference', 'invalid_startxref',
    'unsupported_encryption', 'password_required', 'decompression_limit_exceeded', 'page_limit_exceeded',
    'parser_timeout', 'parser_crash', 'unsupported_pdf_feature', 'unknown_malformed_structure',
]);
export const PublicParserErrorSchema = z.object({
    code: ParserErrorCodeSchema,
    category: ParserCategorySchema,
    message: z.string(),
    retryable: z.boolean(),
    requiresPassword: z.boolean(),
    requiresConfigurationChange: z.boolean(),
    diagnosticId: z.string().optional(),
});
const GeneralErrorSchema = z.object({ code: z.string().min(1).refine(code => !code.startsWith('PDF_'), 'Parser codes must be enumerated'), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });
export const PublicErrorSchema = z.union([PublicParserErrorSchema, GeneralErrorSchema]);
export const WarningSchema = z.object({
    code: z.string().min(1), message: z.string().optional(), page: z.number().int().positive().optional(),
    elementId: z.string().optional(), sourceId: z.string().nullable().optional(), subtype: z.string().optional(),
});
export const OmissionSchema = z.object({ id: z.string(), reason: z.string() });
export const DiagnosticSchema = z.object({ enforcement: z.record(z.string(), z.string()).optional(), operationId: z.string().optional(), timing: z.record(z.string(), z.number()).optional() });

export const BudgetSchema = z.object({
    estimatedTokens: z.number().int().min(0).optional(), responseBytes: z.number().int().min(0).optional(),
    pages: z.number().int().min(0).optional(), textBlocks: z.number().int().min(0).optional(),
    tables: z.number().int().min(0).optional(), figures: z.number().int().min(0).optional(),
    renderedPages: z.number().int().min(0).optional(), imageDimension: z.number().int().min(0).optional(),
}).optional();

export const OpenSchema = z.object({
    source: z.string().min(1).optional(),
    sourceLabel: z.string().max(128).optional(),
    sourceId: SourceIdSchema.optional(),
    pages: z.array(PageInterval).min(1).optional(),
    maxImageDimension: z.number().int().min(64).max(4096).optional(),
    refresh: z.boolean().optional(),
    ocrPolicy: z.enum(['auto', 'off', 'required']).optional(),
    cursor: z.string().min(1).optional(),
    documentId: DocumentIdSchema.optional(),
    extractionFingerprint: ExtractionFingerprintSchema.optional(),
});
export const DocumentInfoSchema = z.object(DocumentReference);
export const SearchSchema = z.object({
    ...DocumentReference, query: z.string().min(1), strategy: z.enum(['full_text', 'semantic', 'hybrid']).optional(),
    pages: z.array(z.number().int().min(1)).optional(),
    elementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(), cursor: z.string().min(1).optional(), budget: BudgetSchema,
});
export const GetPagesSchema = z.object({
    ...DocumentReference, pages: z.array(z.number().int().min(1)).min(1).optional(), pageRanges: z.array(PageInterval).min(1).optional(),
    mode: z.enum(['text', 'balanced', 'fidelity']).optional(), includeElementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(),
    excludeElementTypes: z.array(z.enum(['block', 'table', 'figure', 'annotation', 'link'])).optional(), cursor: z.string().min(1).optional(), budget: BudgetSchema,
});
export const GetElementSchema = z.object({ ...DocumentReference, elementId: z.string().min(1) });
export const RenderPageSchema = z.object({
    ...DocumentReference, page: z.number().int().min(1), bbox: z.union([BoundingBoxSchema, LegacyBoundingBoxSchema]).optional(),
    format: z.enum(['auto', 'png', 'jpeg']).optional(), maxDimension: z.number().int().min(64).max(4096).optional(),
    imageDelivery: z.enum(['auto', 'resource', 'inline']).optional(), budget: BudgetSchema,
});
export const CloseSchema = z.object({ ...DocumentReference, sourceId: SourceIdSchema.optional(), deleteCache: z.boolean().optional() });

const ErrorDataSchema = z.object({ error: PublicErrorSchema });
const CacheStatusSchema = z.object({
    mode: z.enum(['persistent', 'ephemeral', 'none']), location: z.string(), permissionStatus: z.string(),
    retentionDays: z.number().nonnegative(), maxBytes: z.number().positive(), stores: z.array(z.string()),
    processLocal: z.boolean(), activeLeases: z.number().int().nonnegative().optional(),
});
const BudgetResultSchema = z.object({ configured: z.record(z.string(), z.number()), usage: z.record(z.string(), z.number()), estimators: z.record(z.string(), z.string()) });
const SearchResultSchema = z.object({
    id: z.string(), page: z.number().int().positive(), type: z.string(), readingOrder: z.number().int(), score: z.number(),
    matchedTerms: z.array(z.string()), snippet: z.string(), citation: CitationSchema,
});
const RenderAssetSchema = z.object({
    id: z.string(), kind: z.string(), documentId: DocumentIdSchema, extractionFingerprint: ExtractionFingerprintSchema,
    mimeType: z.string(), width: z.number().nonnegative(), height: z.number().nonnegative(), data: z.string().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), uri: z.string().startsWith('pdf-decompiler://'),
    enforcement: z.record(z.string(), z.string()), budget: BudgetResultSchema,
});

const MetadataSchema = z.object({
    title: z.string().optional(), author: z.string().optional(), subject: z.string().optional(), keywords: z.string().optional(),
    creator: z.string().optional(), creationDate: z.string().optional(), modDate: z.string().optional(),
});
const OutlineItemSchema = z.object({ title: z.string(), page: z.number().int().positive().optional(), items: z.lazy(() => z.array(OutlineItemSchema)).optional() });
const PartialSchema = z.object({
    timedOut: z.boolean(), selectionIncomplete: z.boolean().optional(), nextPage: z.number().int().positive(),
    processedPages: z.number().int().nonnegative(), remainingPages: z.number().int().nonnegative(),
});
const PageSchema = z.object({
    id: z.string().regex(/^page:\d+$/), number: z.number().int().positive(), width: z.number().nonnegative(), height: z.number().nonnegative(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    extractionMode: z.enum(['native', 'filtered', 'visual_fallback', 'ocr', 'error']),
    routingMode: z.enum(['native_text', 'native_table_heavy', 'native_visual_regions', 'filtered', 'page_visual_fallback', 'page_visual_unknown', 'page_ocr', 'page_error']),
    contentClass: z.enum(['text', 'structured_text', 'dense_text', 'table', 'visual', 'scan_like', 'ocr_text', 'blank', 'error']),
    visualType: z.enum(['none', 'raster', 'vector', 'mixed', 'unknown']), visualSignals: PageVisualSignalsSchema,
    ocr: z.object({ attempted: z.boolean(), accepted: z.boolean(), reason: z.string().nullable() }),
    diagnostics: z.object({ annotationWidgetCount: z.number().int().nonnegative() }), warnings: z.array(WarningSchema), elementIds: z.array(z.string()),
});

const OpenDataSchema = z.object({
    documentId: DocumentIdSchema, extractionFingerprint: ExtractionFingerprintSchema, sourceId: SourceIdSchema,
    sourceDescriptor: SourceDescriptorSchema, totalPages: z.number().int().positive(), processedPages: z.number().int().nonnegative(),
    complete: z.boolean(), nextCursor: z.string().nullable(), cacheHit: z.boolean(), cache: CacheStatusSchema, diagnostics: DiagnosticSchema.nullable(),
});
const DocumentInfoDataSchema = z.object({
    schemaVersion: z.literal('3.0.0'), canonicalFormatVersion: z.literal(2), extractionRevision: z.literal(2),
    documentId: DocumentIdSchema, pdfSha256: z.string().regex(/^[a-f0-9]{64}$/), extractionFingerprint: ExtractionFingerprintSchema,
    dependencyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), metadata: MetadataSchema, outline: z.array(OutlineItemSchema),
    totalPages: z.number().int().positive(), processedPages: z.number().int().nonnegative(), partial: PartialSchema.nullable(),
    pages: z.array(PageSchema), warnings: z.array(WarningSchema), createdAt: z.string().datetime(), activeSources: z.array(SourceDescriptorSchema),
    counts: z.object({ block: z.number().int().nonnegative(), table: z.number().int().nonnegative(), figure: z.number().int().nonnegative(), annotation: z.number().int().nonnegative(), link: z.number().int().nonnegative() }),
    cache: CacheStatusSchema, resourceLifetime: z.enum(['until_generation_deleted_or_evicted', 'owning_process_and_document_lifetime', 'active_document_lifetime']),
});
const SearchDataSchema = z.object({
    query: z.string(), strategy: z.enum(['full_text', 'semantic', 'hybrid']), results: z.array(SearchResultSchema),
    warnings: z.array(WarningSchema), omissions: z.array(OmissionSchema), budget: BudgetResultSchema, nextCursor: z.string().nullable(),
});
const PagesDataSchema = z.object({
    mode: z.enum(['text', 'balanced', 'fidelity']), pages: z.array(z.number().int().positive()), elements: z.array(ElementSchema),
    citations: z.array(CitationSchema), omissions: z.array(OmissionSchema), budget: BudgetResultSchema, nextCursor: z.string().nullable(),
});
const CloseDataSchema = z.object({
    closed: z.boolean(), sourceId: SourceIdSchema, remainingHandles: z.number().int().nonnegative(), cacheDeleted: z.boolean(), deletionVerified: z.boolean(),
});

function envelope(operation, dataSchema) {
    return z.object({
        schemaVersion: z.literal('3.0.0'), operation: z.literal(operation), documentId: DocumentIdSchema.nullable(),
        extractionFingerprint: ExtractionFingerprintSchema.nullable(), data: z.union([dataSchema, ErrorDataSchema]),
        citations: z.array(CitationSchema), warnings: z.array(WarningSchema), diagnostics: DiagnosticSchema.nullable(),
        omissions: z.array(OmissionSchema), budget: BudgetResultSchema.nullable(), nextCursor: z.string().nullable(),
    });
}

export const OutputSchemas = {
    pdf_open: envelope('pdf_open', OpenDataSchema),
    pdf_document_info: envelope('pdf_document_info', DocumentInfoDataSchema),
    pdf_search: envelope('pdf_search', SearchDataSchema),
    pdf_get_pages: envelope('pdf_get_pages', PagesDataSchema),
    pdf_get_element: envelope('pdf_get_element', ElementSchema),
    pdf_render_page: envelope('pdf_render_page', RenderAssetSchema),
    pdf_close: envelope('pdf_close', CloseDataSchema),
};

export const EnvelopeSchema = z.union(Object.values(OutputSchemas));
