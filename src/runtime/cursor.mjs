import { equalBytes, fingerprint, hmac } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';

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

    encode({ documentId, extractionFingerprint, operation, argumentsValue, position }) {
        const issuedAt = this.now();
        const payload = {
            v: 1,
            kid: this.activeKeyId,
            d: documentId,
            g: extractionFingerprint,
            o: operation,
            a: this.argumentsDigest(argumentsValue),
            p: position,
            iat: issuedAt,
            exp: issuedAt + this.ttlMs,
        };
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${encoded}.${hmac(this.keys.get(this.activeKeyId), encoded).toString('base64url')}`;
    }

    decode(cursor, expected) {
        if (typeof cursor !== 'string' || cursor.length > 4096) throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        const parts = cursor.split('.');
        if (parts.length !== 2) throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        let payload;
        try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch {
            throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.');
        }
        if (payload.v !== 1 || typeof payload.kid !== 'string') throw new PdfDecompilerError('invalid_cursor', 'The cursor version is unsupported.');
        const key = this.keys.get(payload.kid);
        if (!key) throw new PdfDecompilerError('retired_cursor_key', 'The cursor key is unknown or retired.');
        let supplied;
        try { supplied = Buffer.from(parts[1], 'base64url'); } catch { throw new PdfDecompilerError('invalid_cursor', 'The cursor is malformed.'); }
        if (!equalBytes(hmac(key, parts[0]), supplied)) throw new PdfDecompilerError('invalid_cursor', 'The cursor signature is invalid.');
        if (payload.exp < this.now() || payload.iat > this.now() + 60_000) throw new PdfDecompilerError('stale_cursor', 'The cursor has expired.');
        if (payload.d !== expected.documentId || payload.g !== expected.extractionFingerprint || payload.o !== expected.operation) {
            throw new PdfDecompilerError('stale_cursor', 'The cursor belongs to different document state.');
        }
        if (payload.a !== this.argumentsDigest(expected.argumentsValue)) throw new PdfDecompilerError('changed_cursor_arguments', 'The cursor arguments have changed.');
        if (!Number.isSafeInteger(payload.p) || payload.p < 0) throw new PdfDecompilerError('invalid_cursor', 'The cursor position is invalid.');
        return payload.p;
    }
}
