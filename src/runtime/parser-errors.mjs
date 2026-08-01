export const PARSER_ERRORS = Object.freeze({
    PDF_INVALID_SIGNATURE: { category: 'invalid_pdf_signature', message: 'The source does not have a valid PDF signature.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
    PDF_TRUNCATED: { category: 'truncated_document', message: 'The PDF appears to be truncated.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
    PDF_INVALID_XREF: { category: 'invalid_cross_reference', message: 'The PDF cross-reference structure is invalid.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
    PDF_INVALID_STARTXREF: { category: 'invalid_startxref', message: 'The PDF startxref pointer is missing or invalid.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
    PDF_UNSUPPORTED_ENCRYPTION: { category: 'unsupported_encryption', message: 'The PDF uses unsupported encryption.', retryable: false, requiresPassword: false, requiresConfigurationChange: true },
    PDF_PASSWORD_REQUIRED: { category: 'password_required', message: 'The PDF requires a password.', retryable: true, requiresPassword: true, requiresConfigurationChange: false },
    PDF_DECOMPRESSION_LIMIT: { category: 'decompression_limit_exceeded', message: 'The PDF exceeded the decompression limit.', retryable: false, requiresPassword: false, requiresConfigurationChange: true },
    PDF_PAGE_LIMIT: { category: 'page_limit_exceeded', message: 'The PDF exceeded the configured page limit.', retryable: false, requiresPassword: false, requiresConfigurationChange: true },
    PDF_PARSER_TIMEOUT: { category: 'parser_timeout', message: 'PDF parsing exceeded the wall-clock limit.', retryable: true, requiresPassword: false, requiresConfigurationChange: true },
    PDF_PARSER_CRASH: { category: 'parser_crash', message: 'The isolated PDF parser stopped unexpectedly.', retryable: true, requiresPassword: false, requiresConfigurationChange: false },
    PDF_UNSUPPORTED_FEATURE: { category: 'unsupported_pdf_feature', message: 'The PDF uses a feature that is not supported.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
    PDF_MALFORMED_UNKNOWN: { category: 'unknown_malformed_structure', message: 'The PDF structure is malformed.', retryable: false, requiresPassword: false, requiresConfigurationChange: false },
});

export function parserErrorPayload(code, diagnosticId = undefined) {
    const definition = PARSER_ERRORS[code] || PARSER_ERRORS.PDF_MALFORMED_UNKNOWN;
    return { code: PARSER_ERRORS[code] ? code : 'PDF_MALFORMED_UNKNOWN', ...definition, ...(diagnosticId ? { diagnosticId } : {}) };
}

export function isParserErrorPayload(value) {
    const definition = value && PARSER_ERRORS[value.code];
    return Boolean(definition
        && value.category === definition.category
        && value.message === definition.message
        && typeof value.retryable === 'boolean'
        && typeof value.requiresPassword === 'boolean'
        && typeof value.requiresConfigurationChange === 'boolean');
}

export function classifyParserFailure(error) {
    const value = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`.toLowerCase();
    if (/password|needpassword|passwordexception/.test(value)) return 'PDF_PASSWORD_REQUIRED';
    if (/unsupported.*encrypt|encryption.*unsupported/.test(value)) return 'PDF_UNSUPPORTED_ENCRYPTION';
    if (/invalid pdf signature|pdf signature|header.*pdf/.test(value)) return 'PDF_INVALID_SIGNATURE';
    if (/startxref/.test(value)) return 'PDF_INVALID_STARTXREF';
    if (/cross.reference|xref/.test(value)) return 'PDF_INVALID_XREF';
    if (/unexpected end|unexpected eof|truncat|premature end/.test(value)) return 'PDF_TRUNCATED';
    if (/decompress|inflated|output exceeded limit/.test(value)) return 'PDF_DECOMPRESSION_LIMIT';
    if (/page count|page limit|exceeds limit/.test(value)) return 'PDF_PAGE_LIMIT';
    if (/unsupported|not implemented/.test(value)) return 'PDF_UNSUPPORTED_FEATURE';
    return 'PDF_MALFORMED_UNKNOWN';
}
