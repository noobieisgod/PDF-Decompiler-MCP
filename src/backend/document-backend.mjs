import { openHybridDocumentBackend } from './hybrid-document-backend.mjs';
import { openPdfjsDocumentBackend } from './pdfjs-backend.mjs';

export async function openDocumentBackend(pdfBytes, options = {}) {
    const preferred = options.preferredBackend ?? 'hybrid';
    if (preferred === 'hybrid') {
        return openHybridDocumentBackend(pdfBytes);
    }
    if (preferred === 'pdfjs') {
        return openPdfjsDocumentBackend(pdfBytes);
    }
    throw new Error(`Unsupported document backend: ${preferred}`);
}
