import { openPdfjsDocumentBackend } from './pdfjs-backend.mjs';
import { getMupdfDocMetadata, getMupdfDocOutline } from './mupdf-page-data.mjs';
import { openMupdfDocument, renderMupdfPageToCanvas } from './mupdf-runtime.mjs';

export async function openHybridDocumentBackend(pdfBytes) {
    const [pdfjsBackend, mupdfDoc] = await Promise.all([
        openPdfjsDocumentBackend(pdfBytes),
        Promise.resolve(openMupdfDocument(pdfBytes)),
    ]);
    const pageRasterCache = new Map();

    return {
        name: 'hybrid',
        capabilities: {
            ...pdfjsBackend.capabilities,
            metadataBackend: 'mupdf',
            outlineBackend: 'mupdf',
            pageRasterBackend: 'mupdf',
        },
        getTotalPages() {
            return mupdfDoc.countPages();
        },
        async getMetadata() {
            return getMupdfDocMetadata(mupdfDoc) ?? pdfjsBackend.getMetadata();
        },
        async getOutline() {
            return getMupdfDocOutline(mupdfDoc) ?? pdfjsBackend.getOutline();
        },
        async loadPageData(pageNum) {
            const pageData = await pdfjsBackend.loadPageData(pageNum);
            let rasterPromise = null;
            return {
                ...pageData,
                renderPageCanvas: async () => {
                    if (!rasterPromise) {
                        rasterPromise = Promise.resolve(renderMupdfPageToCanvas(mupdfDoc, pageNum, pageData.viewport));
                        pageRasterCache.set(pageNum, rasterPromise);
                    }
                    return rasterPromise;
                },
                pageRasterBackend: 'mupdf',
            };
        },
        async destroy() {
            pageRasterCache.clear();
            await pdfjsBackend.destroy();
            mupdfDoc.destroy?.();
        },
    };
}
