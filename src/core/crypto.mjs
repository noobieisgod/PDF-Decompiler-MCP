import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function fingerprint(value) {
    return sha256(stableJson(value));
}

export function hmac(key, value) {
    return createHmac('sha256', key).update(value).digest();
}

export function equalBytes(a, b) {
    return a.length === b.length && timingSafeEqual(a, b);
}

export function randomKey(size = 32) {
    return randomBytes(size);
}
