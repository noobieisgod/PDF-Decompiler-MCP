import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

import {
    OCR_MAX_REPEATED_RATIO,
    OCR_MAX_CORRUPTED_LINE_RATIO,
    OCR_MAX_SHORT_TOKEN_RATIO,
    OCR_MAX_SYMBOL_HEAVY_RATIO,
    OCR_MIN_ALNUM_RATIO,
    OCR_MIN_CHARS,
    OCR_MIN_WORDLIKE_RATIO,
    OCR_MIN_WORDS,
} from '../config/constants.mjs';
import { unionBBoxes } from '../model/geometry.mjs';

let tesseractAvailableCache;

export function detectTesseract() {
    if (typeof tesseractAvailableCache === 'boolean') {
        return tesseractAvailableCache;
    }
    try {
        const probe = spawnSync('tesseract', ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
        });
        tesseractAvailableCache = probe.status === 0;
    } catch {
        tesseractAvailableCache = false;
    }
    return tesseractAvailableCache;
}

export function ocrTextLooksGood(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
        return { ok: false, reason: 'OCR output was empty' };
    }
    const chars = trimmed.length;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const words = tokens.length;
    const alnum = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
    const alnumRatio = chars ? alnum / chars : 0;
    const repeatedRuns = (trimmed.match(/(.)\1{4,}/g) ?? []).join('').length;
    const repeatedRatio = chars ? repeatedRuns / chars : 0;
    const wordlikeTokens = tokens.filter(token => /^[A-Za-z][A-Za-z'-]{2,}$/.test(token)).length;
    const symbolHeavyTokens = tokens.filter(token => {
        const alnumCount = (token.match(/[A-Za-z0-9]/g) ?? []).length;
        const symbolCount = token.length - alnumCount;
        return symbolCount > alnumCount;
    }).length;
    const shortTokens = tokens.filter(token => token.replace(/[^A-Za-z]/g, '').length > 0 && token.replace(/[^A-Za-z]/g, '').length <= 2).length;
    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    const corruptedLines = lines.filter(line => {
        const lineTokens = line.split(/\s+/).filter(Boolean);
        if (!lineTokens.length) {
            return false;
        }
        const lineWordlike = lineTokens.filter(token => /^[A-Za-z][A-Za-z'-]{2,}$/.test(token)).length;
        const weirdClusters = (line.match(/[^A-Za-z0-9\s]{3,}/g) ?? []).length;
        return (lineWordlike / lineTokens.length) < 0.35 || weirdClusters > 0;
    }).length;
    const wordlikeRatio = words ? wordlikeTokens / words : 0;
    const symbolHeavyRatio = words ? symbolHeavyTokens / words : 0;
    const shortTokenRatio = words ? shortTokens / words : 0;
    const corruptedLineRatio = lines.length ? corruptedLines / lines.length : 0;
    if (words < OCR_MIN_WORDS || chars < OCR_MIN_CHARS) {
        return { ok: false, reason: 'OCR output too short' };
    }
    if (alnumRatio < OCR_MIN_ALNUM_RATIO) {
        return { ok: false, reason: 'OCR output had too little readable text' };
    }
    if (repeatedRatio > OCR_MAX_REPEATED_RATIO) {
        return { ok: false, reason: 'OCR output looked repetitive or corrupted' };
    }
    if (wordlikeRatio < OCR_MIN_WORDLIKE_RATIO) {
        return { ok: false, reason: 'OCR output did not contain enough usable words' };
    }
    if (symbolHeavyRatio > OCR_MAX_SYMBOL_HEAVY_RATIO) {
        return { ok: false, reason: 'OCR output was too symbol-heavy to trust' };
    }
    if (words >= 10 && shortTokenRatio > OCR_MAX_SHORT_TOKEN_RATIO) {
        return { ok: false, reason: 'OCR output had too many broken short tokens' };
    }
    if (corruptedLineRatio > OCR_MAX_CORRUPTED_LINE_RATIO) {
        return { ok: false, reason: 'OCR output contained too many corrupted lines' };
    }
    return { ok: true, reason: null };
}

function parseTsv(value, geometry) {
    const rows = value.replace(/\r\n/g, '\n').split('\n').slice(1).map(line => line.split('\t')).filter(columns => columns.length >= 12 && columns[0] === '5' && columns[11]?.trim());
    const xScale = geometry?.pageWidth && geometry?.pixelWidth ? geometry.pageWidth / geometry.pixelWidth : 1;
    const yScale = geometry?.pageHeight && geometry?.pixelHeight ? geometry.pageHeight / geometry.pixelHeight : 1;
    const words = rows.map((columns, sourceIndex) => ({
        text: columns[11].trim(),
        block: columns[2],
        paragraph: columns[3],
        line: columns[4],
        confidence: Number(columns[10]),
        sourceIndex,
        bbox: {
            x: Number(columns[6]) * xScale,
            y: Number(columns[7]) * yScale,
            width: Number(columns[8]) * xScale,
            height: Number(columns[9]) * yScale,
        },
    }));
    const grouped = new Map();
    for (const word of words) {
        const key = `${word.block}:${word.paragraph}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(word);
    }
    const blocks = [...grouped.values()].map(group => {
        const lines = new Map();
        for (const word of group) {
            if (!lines.has(word.line)) lines.set(word.line, []);
            lines.get(word.line).push(word);
        }
        return {
            text: [...lines.values()].map(line => line.sort((a, b) => a.bbox.x - b.bbox.x || a.sourceIndex - b.sourceIndex).map(word => word.text).join(' ')).join('\n'),
            role: 'ocr',
            bbox: unionBBoxes(group.map(word => word.bbox), geometry?.pageWidth, geometry?.pageHeight),
            spans: group,
            sourceIndex: Math.min(...group.map(word => word.sourceIndex)),
        };
    }).sort((a, b) => a.bbox?.y - b.bbox?.y || a.bbox?.x - b.bbox?.x || a.sourceIndex - b.sourceIndex);
    return { words, blocks, text: blocks.map(block => block.text).join('\n\n') };
}

export async function runTesseractOcr(pngBytes, pageNum, geometry = null) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-decompiler-ocr-'));
    const inputPath = path.join(tempDir, `page-${pageNum}.png`);
    try {
        fs.writeFileSync(inputPath, pngBytes);
        const tsv = await new Promise((resolve, reject) => {
            const proc = spawn('tesseract', [inputPath, 'stdout', '--psm', '6', 'tsv'], { windowsHide: true });
            const chunks = [];
            const errChunks = [];
            proc.stdout.on('data', data => chunks.push(data));
            proc.stderr.on('data', data => errChunks.push(data));
            const timer = setTimeout(() => {
                proc.kill();
                reject(new Error('Tesseract timed out'));
            }, 30000);
            proc.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) {
                    reject(new Error(Buffer.concat(errChunks).toString().trim() || `tesseract exited with status ${code}`));
                } else {
                    resolve(Buffer.concat(chunks).toString('utf8'));
                }
            });
            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
        const parsed = parseTsv(tsv, geometry);
        const cleaned = parsed.text.trim();
        const quality = ocrTextLooksGood(cleaned);
        if (!quality.ok) {
            return { ok: false, text: cleaned, blocks: parsed.blocks, words: parsed.words, reason: quality.reason };
        }
        return { ok: true, text: cleaned, blocks: parsed.blocks, words: parsed.words, reason: null };
    } catch {
        return { ok: false, text: '', reason: 'OCR process failed' };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
        }
    }
}
