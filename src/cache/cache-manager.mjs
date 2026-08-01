import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprint, randomKey, sha256 } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';

const DAY = 86_400_000;
const execFileAsync = promisify(execFile);

async function exists(target) {
    return fs.access(target).then(() => true, () => false);
}

async function atomicJson(target, value, mode = 0o600) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await fs.rename(temp, target);
}

function processAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function ownerIdentity() {
    return fingerprint({ user: os.userInfo().username, uid: process.getuid?.() ?? null, home: os.homedir() }).slice(0, 24);
}

async function directoryBytes(root) {
    let total = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) total += await directoryBytes(target);
        else total += (await fs.stat(target).catch(() => ({ size: 0 }))).size;
    }
    return total;
}

async function restrictWindowsDirectory(root) {
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
    await execFileAsync('icacls.exe', [root, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`], { windowsHide: true, timeout: 10_000 });
}

export class CacheManager {
    constructor(config) {
        this.config = config;
        this.mode = config.cache.mode;
        this.ownerId = ownerIdentity();
        this.processId = `${process.pid}-${Date.now()}-${randomUUID()}`;
        this.leases = new Map();
    }

    async init() {
        if (this.mode === 'persistent') {
            this.root = path.join(this.config.cache.directory, 'users', this.ownerId);
            await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
            await fs.chmod(this.root, 0o700).catch(() => {});
            if (process.platform === 'win32') {
                await restrictWindowsDirectory(this.root).catch(error => {
                    if (!this.config.cache.allowSharedRoot) throw new PdfDecompilerError('unsafe_cache_permissions', 'The persistent cache ACL could not be restricted to its owner.', { cause: error.code });
                });
            }
            const stat = await fs.stat(this.root);
            if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0 && !this.config.cache.allowSharedRoot) {
                throw new PdfDecompilerError('unsafe_cache_permissions', 'Persistent cache permissions are not owner-restricted.');
            }
            this.permissionStatus = process.platform === 'win32' ? 'windows-acl-owner-restricted' : 'verified-owner-only';
        } else {
            const activeRoot = path.join(os.tmpdir(), 'pdf-decompiler-mcp-active', this.ownerId);
            await fs.mkdir(activeRoot, { recursive: true, mode: 0o700 });
            await this.cleanupAbandoned(activeRoot);
            this.root = path.join(activeRoot, this.processId);
            await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
            if (process.platform === 'win32') await restrictWindowsDirectory(this.root);
            await atomicJson(path.join(this.root, 'owner.json'), { ownerId: this.ownerId, pid: process.pid, createdAt: Date.now(), mode: this.mode });
            this.permissionStatus = 'owner-restricted-temporary';
        }
        await fs.mkdir(path.join(this.root, 'documents'), { recursive: true, mode: 0o700 });
        await fs.mkdir(path.join(this.root, 'locks'), { recursive: true, mode: 0o700 });
        await this.loadCursorKeys();
        return this;
    }

    async cleanupAbandoned(activeRoot) {
        const cutoff = Date.now() - DAY;
        for (const entry of await fs.readdir(activeRoot, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory()) continue;
            const target = path.join(activeRoot, entry.name);
            const owner = await fs.readFile(path.join(target, 'owner.json'), 'utf8').then(JSON.parse, () => null);
            if (!owner || owner.ownerId !== this.ownerId || owner.createdAt > cutoff || processAlive(owner.pid)) continue;
            await fs.rm(target, { recursive: true, force: true });
        }
    }

    async loadCursorKeys() {
        const target = path.join(this.root, 'cursor-keys.json');
        this.cursorKeys = await this.withLock('_cache', 'cursor-keys', async () => {
            let stored = await fs.readFile(target, 'utf8').then(JSON.parse, () => null);
            if (!stored?.activeKeyId || !stored?.keys?.[stored.activeKeyId]) {
                const key = randomKey();
                const keyId = sha256(key).slice(0, 16);
                stored = { activeKeyId: keyId, keys: { [keyId]: key.toString('base64') }, createdAt: new Date().toISOString() };
                await atomicJson(target, stored);
            }
            return stored;
        });
    }

    cursorKeyring() {
        return {
            activeKeyId: this.cursorKeys.activeKeyId,
            keys: Object.fromEntries(Object.entries(this.cursorKeys.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')])),
        };
    }

    async rotateCursorKey({ retainPrevious = true } = {}) {
        return this.withLock('_cache', 'cursor-keys', async () => {
            const stored = await fs.readFile(path.join(this.root, 'cursor-keys.json'), 'utf8').then(JSON.parse);
            const key = randomKey();
            const keyId = sha256(key).slice(0, 16);
            const keys = retainPrevious ? stored.keys : {};
            this.cursorKeys = { activeKeyId: keyId, keys: { ...keys, [keyId]: key.toString('base64') }, rotatedAt: new Date().toISOString() };
            await atomicJson(path.join(this.root, 'cursor-keys.json'), this.cursorKeys);
            return keyId;
        });
    }

    generationPath(documentId, generation) {
        return path.join(this.root, 'documents', documentId, generation);
    }

    derivedPath(documentId, generation, id) {
        return path.join(this.root, 'derived', documentId, generation, `${sha256(id)}.json`);
    }

    semanticPath(documentId, generation) {
        return path.join(this.root, 'indexes', documentId, generation, 'semantic.json');
    }

    async generationExists(documentId, generation) {
        return exists(path.join(this.generationPath(documentId, generation), 'manifest.json'));
    }

    lockPath(documentId, generation) {
        return path.join(this.root, 'locks', `${documentId}-${generation}.lock`);
    }

    async withLock(documentId, generation, callback, timeoutMs = 10_000) {
        const lock = this.lockPath(documentId, generation);
        const deadline = Date.now() + timeoutMs;
        await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
        while (true) {
            try {
                const handle = await fs.open(lock, 'wx', 0o600);
                await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
                await handle.close();
                break;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const stale = await fs.readFile(lock, 'utf8').then(JSON.parse, () => null);
                if (stale && Date.now() - stale.createdAt > 60_000 && !processAlive(stale.pid)) {
                    await fs.rm(lock, { force: true });
                    continue;
                }
                if (Date.now() >= deadline) throw new PdfDecompilerError('cache_locked', 'The document cache is busy.');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        try { return await callback(); } finally { await fs.rm(lock, { force: true }); }
    }

    async saveGeneration(model, pdfBytes, bm25 = null, semantic = null) {
        const destination = this.generationPath(model.documentId, model.extractionFingerprint);
        return this.withLock(model.documentId, model.extractionFingerprint, async () => {
            if (await exists(path.join(destination, 'manifest.json'))) return destination;
            const staging = `${destination}.staging-${process.pid}-${randomUUID()}`;
            await fs.mkdir(path.join(staging, 'assets'), { recursive: true, mode: 0o700 });
            const persistedAssets = [];
            for (const asset of model.assets) {
                const extension = asset.mimeType === 'image/jpeg' ? 'jpg' : 'png';
                const filename = `${sha256(asset.id).slice(0, 24)}.${extension}`;
                if (asset.data) await fs.writeFile(path.join(staging, 'assets', filename), Buffer.from(asset.data, 'base64'), { mode: 0o600 });
                persistedAssets.push({ ...asset, data: undefined, filename });
            }
            const persistedModel = { ...model, assets: persistedAssets };
            await fs.writeFile(path.join(staging, 'source.pdf'), pdfBytes, { mode: 0o600 });
            await atomicJson(path.join(staging, 'canonical.json'), persistedModel);
            if (bm25) await atomicJson(path.join(staging, 'bm25.json'), bm25);
            if (semantic) await atomicJson(path.join(staging, 'semantic.json'), semantic);
            const manifest = {
                version: 1,
                documentId: model.documentId,
                extractionFingerprint: model.extractionFingerprint,
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
                pdfSha256: model.pdfSha256,
                files: {
                    'source.pdf': sha256(pdfBytes),
                    'canonical.json': sha256(await fs.readFile(path.join(staging, 'canonical.json'))),
                },
            };
            for (const asset of persistedAssets) {
                if (asset.filename) manifest.files[`assets/${asset.filename}`] = sha256(await fs.readFile(path.join(staging, 'assets', asset.filename)));
            }
            await atomicJson(path.join(staging, 'manifest.json'), manifest);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await fs.rename(staging, destination);
            await fs.rm(this.tombstonePath(model.documentId, model.extractionFingerprint), { force: true });
            return destination;
        });
    }

    tombstonePath(documentId, generation) {
        return path.join(this.root, 'tombstones', `${documentId}-${generation}.json`);
    }

    async loadGeneration(documentId, generation) {
        const root = this.generationPath(documentId, generation);
        const manifest = await fs.readFile(path.join(root, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
        if (!manifest || manifest.documentId !== documentId || manifest.extractionFingerprint !== generation) return null;
        const canonicalBytes = await fs.readFile(path.join(root, 'canonical.json')).catch(() => null);
        if (!canonicalBytes || sha256(canonicalBytes) !== manifest.files['canonical.json']) {
            await this.deleteGeneration(documentId, generation, { ignoreMissing: true, reason: 'corrupt' });
            return null;
        }
        const model = JSON.parse(canonicalBytes.toString('utf8'));
        for (const asset of model.assets) {
            const assetPath = path.join(root, 'assets', asset.filename);
            const bytes = await fs.readFile(assetPath).catch(() => null);
            const expected = manifest.files[`assets/${asset.filename}`];
            if (!bytes || !expected || sha256(bytes) !== expected) {
                await this.deleteGeneration(documentId, generation, { ignoreMissing: true, reason: 'corrupt' });
                return null;
            }
            asset.data = bytes.toString('base64');
        }
        manifest.lastAccessedAt = Date.now();
        await atomicJson(path.join(root, 'manifest.json'), manifest);
        const bm25 = await fs.readFile(path.join(root, 'bm25.json'), 'utf8').then(JSON.parse, () => null);
        const semantic = await fs.readFile(this.semanticPath(documentId, generation), 'utf8').then(JSON.parse, () =>
            fs.readFile(path.join(root, 'semantic.json'), 'utf8').then(JSON.parse, () => null));
        return { model, pdfBytes: await fs.readFile(path.join(root, 'source.pdf')), bm25, semantic };
    }

    async saveSemanticIndex(documentId, generation, semantic) {
        if (!(await this.generationExists(documentId, generation))) throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
        const target = this.semanticPath(documentId, generation);
        if (!(await exists(target))) await atomicJson(target, semantic);
    }

    async saveDerivedAsset(asset) {
        if (!(await this.generationExists(asset.documentId, asset.extractionFingerprint))) {
            throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
        }
        const target = this.derivedPath(asset.documentId, asset.extractionFingerprint, asset.id);
        if (!(await exists(target))) await atomicJson(target, asset);
        return target;
    }

    async loadDerivedAsset(documentId, generation, id) {
        const asset = await fs.readFile(this.derivedPath(documentId, generation, id), 'utf8').then(JSON.parse, () => null);
        if (!asset || asset.documentId !== documentId || asset.extractionFingerprint !== generation || asset.id !== id) return null;
        if (!asset.data || sha256(Buffer.from(asset.data, 'base64')) !== asset.sha256) return null;
        return asset;
    }

    async acquireLease(documentId, generation) {
        if (!(await this.generationExists(documentId, generation))) throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
        const root = this.generationPath(documentId, generation);
        const leaseId = `${process.pid}-${randomUUID()}`;
        const leasePath = path.join(root, 'leases', `${leaseId}.json`);
        await atomicJson(leasePath, { pid: process.pid, ownerId: this.ownerId, createdAt: Date.now() });
        this.leases.set(leaseId, leasePath);
        return leaseId;
    }

    async releaseLease(leaseId) {
        const target = this.leases.get(leaseId);
        if (!target) return;
        await fs.rm(target, { force: true });
        this.leases.delete(leaseId);
    }

    async activeLeases(documentId, generation) {
        const directory = path.join(this.generationPath(documentId, generation), 'leases');
        let active = 0;
        for (const name of await fs.readdir(directory).catch(() => [])) {
            const target = path.join(directory, name);
            const lease = await fs.readFile(target, 'utf8').then(JSON.parse, () => null);
            if (lease && lease.ownerId === this.ownerId && processAlive(lease.pid)) active += 1;
            else await fs.rm(target, { force: true });
        }
        return active;
    }

    async deleteGeneration(documentId, generation, { ignoreMissing = false, reason = 'deleted' } = {}) {
        return this.withLock(documentId, generation, async () => {
            const target = this.generationPath(documentId, generation);
            if (!(await exists(target))) {
                if (ignoreMissing) {
                    await atomicJson(this.tombstonePath(documentId, generation), { reason, deletedAt: Date.now() });
                    return { deleted: false, verified: true };
                }
                throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
            }
            if (await this.activeLeases(documentId, generation)) throw new PdfDecompilerError('active_generation', 'The extraction generation is actively leased.');
            await fs.rm(target, { recursive: true, force: true });
            await fs.rm(path.join(this.root, 'derived', documentId, generation), { recursive: true, force: true });
            await fs.rm(path.dirname(this.semanticPath(documentId, generation)), { recursive: true, force: true });
            await atomicJson(this.tombstonePath(documentId, generation), { reason, deletedAt: Date.now() });
            return { deleted: true, verified: !(await exists(target)) };
        });
    }

    async unavailableReason(documentId, generation) {
        const tombstone = await fs.readFile(this.tombstonePath(documentId, generation), 'utf8').then(JSON.parse, () => null);
        return tombstone?.reason || 'missing';
    }

    async cleanupDocumentState(documentId, generation) {
        if (this.mode === 'persistent') return;
        await this.deleteGeneration(documentId, generation, { ignoreMissing: true, reason: 'closed' });
    }

    async evict() {
        if (this.mode !== 'persistent') return { removed: [] };
        const documentsRoot = path.join(this.root, 'documents');
        const entries = [];
        for (const documentName of await fs.readdir(documentsRoot).catch(() => [])) {
            for (const generation of await fs.readdir(path.join(documentsRoot, documentName)).catch(() => [])) {
                const root = path.join(documentsRoot, documentName, generation);
                const manifest = await fs.readFile(path.join(root, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
                if (manifest) entries.push({ documentId: documentName, generation, root, manifest, bytes: await directoryBytes(root) });
            }
        }
        entries.sort((a, b) => a.manifest.lastAccessedAt - b.manifest.lastAccessedAt || a.root.localeCompare(b.root));
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        const cutoff = Date.now() - this.config.cache.retentionDays * DAY;
        const removed = [];
        for (const entry of entries) {
            if (entry.manifest.lastAccessedAt >= cutoff && total <= this.config.cache.maxBytes) continue;
            if (await this.activeLeases(entry.documentId, entry.generation)) continue;
            const result = await this.deleteGeneration(entry.documentId, entry.generation, { ignoreMissing: true, reason: 'evicted' });
            if (result.deleted) { total -= entry.bytes; removed.push({ documentId: entry.documentId, generation: entry.generation }); }
        }
        return { removed, remainingBytes: total };
    }

    status(model) {
        return {
            mode: this.mode,
            location: this.generationPath(model.documentId, model.extractionFingerprint),
            permissionStatus: this.permissionStatus,
            retentionDays: this.config.cache.retentionDays,
            maxBytes: this.config.cache.maxBytes,
            stores: ['original_pdf', 'canonical_json', 'extracted_text', 'images', 'renders', 'bm25_index', 'semantic_index', 'metadata', 'embeddings'],
            processLocal: this.mode !== 'persistent',
        };
    }

    async close() {
        for (const leaseId of [...this.leases.keys()]) await this.releaseLease(leaseId);
        if (this.mode !== 'persistent') await fs.rm(this.root, { recursive: true, force: true });
    }
}
