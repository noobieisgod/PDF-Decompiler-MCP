import { equalBytes, fingerprint, hmac } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';

const MAX_CURSOR_LENGTH = 4096;

function validPosition(value, depth = 0) {
    if (depth > 6) return false;
    if (Number.isSafeInteger(value) && value >= 0) return true;
    if (Array.isArray(value)) return value.length <= 128 && value.every(item => validPosition(item, depth + 1));
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        return entries.length <= 32 && entries.every(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) && validPosition(item, depth + 1));
    }
    return value === null;
}

function validRestorableArguments(value, depth = 0) {
    if (depth > 5) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 128;
    if (Number.isSafeInteger(value) && value >= 0) return true;
    if (Array.isArray(value)) return value.length <= 128 && value.every(item => validRestorableArguments(item, depth + 1));
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        return entries.length <= 32 && entries.every(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) && validRestorableArguments(item, depth + 1));
    }
    return false;
}

export class CursorCodec {
    constructor({ activeKeyId, keys, ttlMs = 3_600_000, now = () => Date.now() }) {
        this.activeKeyId = activeKeyId;
        this.keys = new Map(Object.entries(keys));
        this.ttlMs = ttlMs;
        this.now = now;
        if (!this.keys.has(activeKeyId)) throw new Error('Active cursor key is missing');
    }

    argumentsDigest(argumentsValue) {
        return fingerprint(argumentsValue);
    }

    encode({ documentId, extractionFingerprint, operation, argumentsValue, position, restorableArguments = null }) {
        if (restorableArguments !== null && (operation !== 'pdf_get_pages' || !validRestorableArguments(restorableArguments))) {
            throw new PdfDecompilerError('invalid_cursor', 'The restorable cursor arguments are invalid.');
        }
        const issuedAt = this.now();
        const payload = {
            v: 3,
            kid: this.activeKeyId,
            d: documentId,
            g: extractionFingerprint,
            o: operation,
            a: this.argumentsDigest(argumentsValue),
            p: position,
            r: restorableArguments,
            iat: issuedAt,
            exp: issuedAt + this.ttlMs,
        };
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const cursor = `${encoded}.${hmac(this.keys.get(this.activeKeyId), encoded).toString('base64url')}`;
        if (cursor.length > MAX_CURSOR_LENGTH) throw new PdfDecompilerError('cursor_too_large', 'The continuation state exceeds the cursor size limit.');
        return cursor;
    }

    decode(cursor, expected) {
        if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH) throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        const parts = cursor.split('.');
        if (parts.length !== 2) throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        let payload;
        try {
            const decoded = Buffer.from(parts[0], 'base64url');
            if (decoded.toString('base64url') !== parts[0]) throw new Error('noncanonical payload');
            payload = JSON.parse(decoded.toString('utf8'));
        } catch {
            throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        }
        if (payload.v !== 3 || typeof payload.kid !== 'string') throw new PdfDecompilerError('invalid_cursor', 'The cursor version is unsupported.');
        const key = this.keys.get(payload.kid);
        if (!key) throw new PdfDecompilerError('retired_cursor_key', 'The cursor key is unknown or retired.');
        let supplied;
        try {
            supplied = Buffer.from(parts[1], 'base64url');
            if (supplied.toString('base64url') !== parts[1]) throw new Error('noncanonical signature');
        } catch { throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.'); }
        if (!equalBytes(hmac(key, parts[0]), supplied)) throw new PdfDecompilerError('invalid_cursor', 'The cursor signature is invalid.');
        if (payload.exp < this.now() || payload.iat > this.now() + 60_000) throw new PdfDecompilerError('stale_cursor', 'The cursor has expired.');
        if (payload.d !== expected.documentId || payload.g !== expected.extractionFingerprint || payload.o !== expected.operation) {
            throw new PdfDecompilerError('stale_cursor', 'The cursor belongs to different document state.');
        }
        if (payload.r !== null && (!validRestorableArguments(payload.r) || payload.a !== this.argumentsDigest(payload.r))) throw new PdfDecompilerError('invalid_cursor', 'The cursor arguments are invalid.');
        const argumentsValue = expected.argumentsValue ?? payload.r;
        if (argumentsValue === null || argumentsValue === undefined || payload.a !== this.argumentsDigest(argumentsValue)) throw new PdfDecompilerError('changed_cursor_arguments', 'The cursor arguments have changed.');
        if (!validPosition(payload.p)) throw new PdfDecompilerError('invalid_cursor', 'The cursor position is invalid.');
        return expected.restoreArguments ? { position: payload.p, argumentsValue: payload.r } : payload.p;
    }
}
