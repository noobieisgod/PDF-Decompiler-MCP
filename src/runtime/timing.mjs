import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const TIMING_ENABLED = process.env.PDF_DECOMPILER_TIMING === '1';
const storage = new AsyncLocalStorage();

export function timingContext(operation, callback) {
    if (!TIMING_ENABLED) return callback();
    const context = { operationId: randomUUID(), operation, started: performance.now(), last: performance.now(), phases: {} };
    return storage.run(context, callback);
}

export function timingMark(phase) {
    const context = storage.getStore();
    if (!context) return;
    const now = performance.now();
    context.phases[phase] = Math.round((now - context.last) * 1000) / 1000;
    context.last = now;
}

export function timingSnapshot() {
    const context = storage.getStore();
    return context ? { operationId: context.operationId, timing: { ...context.phases } } : null;
}

export function timingComplete(phase = 'response_handoff') {
    const context = storage.getStore();
    if (!context) return;
    timingMark(phase);
    console.error('[pdf-decompiler-timing]', JSON.stringify({
        operationId: context.operationId,
        operation: context.operation,
        phasesMs: context.phases,
        totalMs: Math.round((performance.now() - context.started) * 1000) / 1000,
    }));
}

export class TimedTransport {
    constructor(inner) {
        this.inner = inner;
        this.pending = new Map();
    }
    set onmessage(handler) {
        this.inner.onmessage = (message, extra) => {
            if (TIMING_ENABLED && message?.method === 'tools/call' && message.id !== undefined) {
                this.pending.set(String(message.id), { operationId: randomUUID(), operation: message.params?.name || 'tools/call', started: performance.now() });
            }
            handler?.(message, extra);
        };
    }
    set onerror(handler) { this.inner.onerror = handler; }
    set onclose(handler) { this.inner.onclose = handler; }
    start() { return this.inner.start(); }
    close() { return this.inner.close(); }
    setProtocolVersion(version) { return this.inner.setProtocolVersion?.(version); }
    async send(message, options) {
        await this.inner.send(message, options);
        if (!TIMING_ENABLED || message?.id === undefined || (!('result' in message) && !('error' in message))) return;
        const record = this.pending.get(String(message.id));
        if (!record) return;
        this.pending.delete(String(message.id));
        console.error('[pdf-decompiler-transport-timing]', JSON.stringify({
            operationId: record.operationId,
            operation: record.operation,
            phase: 'stdio_response_completion',
            totalMs: Math.round((performance.now() - record.started) * 1000) / 1000,
        }));
    }
}
