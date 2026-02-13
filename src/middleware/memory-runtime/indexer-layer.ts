import { Pool, type PoolConfig } from 'pg';
import { resolve } from 'node:path';
import type { AgentMemoryConfig } from '../../config.js';

export interface MemoryIndexerLayerDeps {
    memoryConfig: AgentMemoryConfig;
    workspacePath: string;
    canUsePg: () => boolean;
    buildPgPoolConfig: () => PoolConfig | null;
    getPool: () => Pool | null;
    setPool: (pool: Pool | null) => void;
    ensurePgSchema: () => Promise<void>;
    startBackgroundWorkers: () => void;
    stopBackgroundWorkers: () => void;
    getSessionEventEmbeddingBackfillInFlight: () => Promise<void> | null;
    getSessionEventTtlCleanupInFlight: () => Promise<void> | null;
    getSyncDebounceTimer: () => NodeJS.Timeout | null;
    setSyncDebounceTimer: (timer: NodeJS.Timeout | null) => void;
    setPgReady: (value: boolean) => void;
    setVectorAvailable: (value: boolean) => void;
    setSessionEventsAvailable: (value: boolean) => void;
    setSessionEventVectorAvailable: (value: boolean) => void;
    getSyncInFlight: () => Promise<void> | null;
    setSyncInFlight: (value: Promise<void> | null) => void;
    runIncrementalSync: (options?: { force?: boolean; onlyPaths?: string[] }) => Promise<void>;
    pendingSyncPaths: Set<string>;
    syncIncrementalRef: (options?: { force?: boolean; onlyPaths?: string[] }) => Promise<void>;
    transcriptSyncDebounceMs: number;
}

export class MemoryIndexerLayer {
    constructor(private readonly deps: MemoryIndexerLayerDeps) {}

    async initialize(): Promise<void> {
        const { memoryConfig } = this.deps;
        if (memoryConfig.backend !== 'pgsql' && !memoryConfig.pgsql.enabled) {
            return;
        }

        const poolConfig = this.deps.buildPgPoolConfig();
        if (!poolConfig) {
            console.warn('[Memory] PGSQL backend requested but connection config is incomplete, fallback to filesystem');
            return;
        }

        try {
            const pool = new Pool(poolConfig);
            this.deps.setPool(pool);
            await pool.query('SELECT 1');
            await this.deps.ensurePgSchema();
            this.deps.setPgReady(true);
            await this.deps.syncIncrementalRef({ force: true });
            this.deps.startBackgroundWorkers();
        } catch (error) {
            console.warn('[Memory] PGSQL initialization failed, fallback to filesystem:', error instanceof Error ? error.message : String(error));
            const pool = this.deps.getPool();
            await pool?.end().catch(() => undefined);
            this.deps.setPool(null);
            this.deps.setPgReady(false);
            this.deps.setVectorAvailable(false);
            this.deps.setSessionEventsAvailable(false);
            this.deps.setSessionEventVectorAvailable(false);
        }
    }

    async close(): Promise<void> {
        this.deps.stopBackgroundWorkers();
        await this.deps.getSessionEventEmbeddingBackfillInFlight()?.catch(() => undefined);
        await this.deps.getSessionEventTtlCleanupInFlight()?.catch(() => undefined);
        const syncDebounceTimer = this.deps.getSyncDebounceTimer();
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
            this.deps.setSyncDebounceTimer(null);
        }
        await this.flushPendingSync();
        const pool = this.deps.getPool();
        if (pool) {
            await pool.end().catch(() => undefined);
            this.deps.setPool(null);
        }
        this.deps.setPgReady(false);
        this.deps.setVectorAvailable(false);
        this.deps.setSessionEventsAvailable(false);
        this.deps.setSessionEventVectorAvailable(false);
    }

    async syncIncremental(options?: { force?: boolean; onlyPaths?: string[] }): Promise<void> {
        if (!this.deps.canUsePg()) {
            return;
        }

        const inFlight = this.deps.getSyncInFlight();
        if (inFlight) {
            return inFlight;
        }

        const next = this.deps.runIncrementalSync(options)
            .finally(() => {
                this.deps.setSyncInFlight(null);
            });
        this.deps.setSyncInFlight(next);
        return next;
    }

    schedulePathSync(paths: string[]): void {
        if (!this.deps.canUsePg()) {
            return;
        }

        for (const item of paths) {
            const abs = resolve(item);
            if (abs.startsWith(this.deps.workspacePath)) {
                this.deps.pendingSyncPaths.add(abs);
            }
        }

        if (this.deps.pendingSyncPaths.size === 0) {
            return;
        }

        const syncDebounceTimer = this.deps.getSyncDebounceTimer();
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }

        const nextTimer = setTimeout(() => {
            this.deps.setSyncDebounceTimer(null);
            void this.flushPendingSync();
        }, this.deps.transcriptSyncDebounceMs);
        this.deps.setSyncDebounceTimer(nextTimer);
    }

    async flushPendingSync(): Promise<void> {
        if (!this.deps.canUsePg()) {
            this.deps.pendingSyncPaths.clear();
            return;
        }
        if (this.deps.pendingSyncPaths.size === 0) {
            return;
        }

        const paths = Array.from(this.deps.pendingSyncPaths);
        this.deps.pendingSyncPaths.clear();
        await this.deps.syncIncrementalRef({ onlyPaths: paths, force: true })
            .catch((error) => {
                console.warn('[Memory] deferred incremental sync failed:', error instanceof Error ? error.message : String(error));
            });
    }
}
