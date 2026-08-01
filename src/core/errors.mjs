export class PdfDecompilerError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = 'PdfDecompilerError';
        this.code = code;
        this.details = details;
    }
}

export function publicError(error) {
    if (error instanceof PdfDecompilerError) {
        return error.details === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, message: error.message, details: error.details };
    }
    return { code: 'internal_error', message: 'The operation failed.' };
}
