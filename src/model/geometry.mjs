export const BBOX_TOLERANCE_PT = 0.5;

export function multiplyTransform(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}

export function bboxFromPoints(points) {
    if (!points?.length || points.some(point => !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1]))) return null;
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
}

export function transformPoint(matrix, x, y) {
    return [
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5],
    ];
}

export function transformUnitRect(matrix) {
    return bboxFromPoints([
        transformPoint(matrix, 0, 0),
        transformPoint(matrix, 1, 0),
        transformPoint(matrix, 0, 1),
        transformPoint(matrix, 1, 1),
    ]);
}

export function normalizeBBox(value, pageWidth = null, pageHeight = null) {
    if (!value || typeof value !== 'object') return null;
    let { x, y, width, height } = value;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    if (Number.isFinite(pageWidth) && Number.isFinite(pageHeight) && pageWidth > 0 && pageHeight > 0) {
        if (x < -BBOX_TOLERANCE_PT || y < -BBOX_TOLERANCE_PT
            || x + width > pageWidth + BBOX_TOLERANCE_PT
            || y + height > pageHeight + BBOX_TOLERANCE_PT) return null;
        const right = Math.min(pageWidth, x + width);
        const bottom = Math.min(pageHeight, y + height);
        x = Math.max(0, x);
        y = Math.max(0, y);
        width = right - x;
        height = bottom - y;
    }
    if (width <= 0 || height <= 0) return null;
    return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

export function unionBBoxes(values, pageWidth = null, pageHeight = null) {
    const boxes = values.map(value => normalizeBBox(value, pageWidth, pageHeight)).filter(Boolean);
    if (!boxes.length) return null;
    return normalizeBBox({
        x: Math.min(...boxes.map(box => box.x)),
        y: Math.min(...boxes.map(box => box.y)),
        width: Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x)),
        height: Math.max(...boxes.map(box => box.y + box.height)) - Math.min(...boxes.map(box => box.y)),
    }, pageWidth, pageHeight);
}

export function textItemBBox(item, viewport) {
    if (!item?.transform || !viewport?.transform) return null;
    const matrix = multiplyTransform(viewport.transform, item.transform);
    const width = Math.abs(Number(item.width) || 0) * (viewport.scale || 1);
    const height = Math.abs(Number(item.height) || Math.hypot(matrix[2], matrix[3]) || 0) * (viewport.scale || 1);
    if (!width || !height) return null;
    const baselineLength = Math.hypot(matrix[0], matrix[1]) || 1;
    const ux = matrix[0] / baselineLength;
    const uy = matrix[1] / baselineLength;
    const topX = matrix[4] + (uy * height);
    const topY = matrix[5] - (ux * height);
    return normalizeBBox(bboxFromPoints([
        [topX, topY],
        [topX + ux * width, topY + uy * width],
        [matrix[4], matrix[5]],
        [matrix[4] + ux * width, matrix[5] + uy * width],
    ]), viewport.width, viewport.height);
}

export function pdfRectToBBox(rect, viewport) {
    if (!Array.isArray(rect) || rect.length < 4 || !viewport?.transform) return null;
    const [x1, y1, x2, y2] = rect.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return normalizeBBox(bboxFromPoints([
        transformPoint(viewport.transform, x1, y1),
        transformPoint(viewport.transform, x1, y2),
        transformPoint(viewport.transform, x2, y1),
        transformPoint(viewport.transform, x2, y2),
    ]), viewport.width, viewport.height);
}
