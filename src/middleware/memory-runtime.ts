import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type {
    AgentMemoryConfig,
    AgentMemoryEmbeddingProviderConfig,
    AgentMemoryRetrievalMode,
    Config,
} from '../config.js';
import type { MemoryScope } from './memory-scope.js';

const MAX_SNIPPET_CHARS = 220;
const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const DEFAULT_VECTOR_DIMENSIONS = 1536;
const TRANSCRIPT_SYNC_DEBOUNCE_MS = 1500;

type MemorySourceType = 'daily' | 'long-term' | 'transcript' | 'session';

interface FileMetaRow {
    scope_key: string;
    rel_path: string;
    content_hash: string;
    mtime_ms: number;
    size_bytes: number;
}

interface MemoryChunk {
    chunkIndex: number;
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
}

export interface MemorySearchHit {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: MemorySourceType;
    strategy: AgentMemoryRetrievalMode | 'keyword';
}

export interface MemorySaveResult {
    path: string;
    scope: string;
}

interface SearchRow {
    rel_path: string;
    chunk_index: number;
    start_line: number;
    end_line: number;
    content: string;
    source_type: MemorySourceType;
    score: number;
}

function sortRowsByScore(rows: SearchRow[]): SearchRow[] {
    return rows
        .slice()
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            if (a.rel_path !== b.rel_path) {
                return a.rel_path.localeCompare(b.rel_path);
            }
            return a.chunk_index - b.chunk_index;
        });
}

interface EmbeddingProviderState {
    dimensionMismatch: Set<string>;
}

function quoteIdentifier(input: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input)) {
        throw new Error(`Invalid SQL identifier: ${input}`);
    }
    return `"${input}"`;
}

function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatTimeStamp(date: Date): string {
    return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeRelPath(workspacePath: string, absPath: string): string {
    return relative(workspacePath, absPath).replace(/\\/g, '/');
}

function inferScopeFromRelPath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');
    const match = normalized.match(/^memory\/scopes\/([^/]+)\//);
    return match?.[1] || 'main';
}

function inferSourceType(relPath: string): MemorySourceType {
    const normalized = relPath.replace(/\\/g, '/').toLowerCase();
    const name = basename(normalized);
    if (normalized.includes('/transcripts/')) {
        return 'transcript';
    }
    if (name === 'memory.md' || name === 'long_term.md') {
        return 'long-term';
    }
    return 'daily';
}

function toVectorLiteral(embedding: number[]): string {
    const values = embedding
        .map((value) => Number.isFinite(value) ? String(value) : '0')
        .join(',');
    return `[${values}]`;
}

function isValidEmbedding(embedding: number[]): boolean {
    if (embedding.length !== DEFAULT_VECTOR_DIMENSIONS) {
        return false;
    }
    return embedding.every((value) => Number.isFinite(value));
}

function chunkMarkdown(content: string, maxChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_CHUNK_OVERLAP): MemoryChunk[] {
    const lines = content.split('\n');
    if (lines.length === 0) {
        return [];
    }

    const chunks: MemoryChunk[] = [];
    let buffer: Array<{ line: string; lineNo: number }> = [];
    let bufferChars = 0;
    let chunkIndex = 0;

    const flush = () => {
        if (buffer.length === 0) return;
        const text = buffer.map((entry) => entry.line).join('\n');
        const first = buffer[0];
        const last = buffer[buffer.length - 1];
        if (!first || !last) return;
        chunks.push({
            chunkIndex,
            startLine: first.lineNo,
            endLine: last.lineNo,
            text,
            hash: sha256(text),
        });
        chunkIndex += 1;
    };

    const keepOverlap = () => {
        if (overlapChars <= 0 || buffer.length === 0) {
            buffer = [];
            bufferChars = 0;
            return;
        }
        let size = 0;
        const retained: Array<{ line: string; lineNo: number }> = [];
        for (let i = buffer.length - 1; i >= 0; i -= 1) {
            const row = buffer[i];
            if (!row) continue;
            size += row.line.length + 1;
            retained.unshift(row);
            if (size >= overlapChars) break;
        }
        buffer = retained;
        bufferChars = retained.reduce((acc, row) => acc + row.line.length + 1, 0);
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const segments = line.length === 0
            ? ['']
            : Array.from({ length: Math.ceil(line.length / maxChars) }, (_, idx) =>
                line.slice(idx * maxChars, (idx + 1) * maxChars)
            );

        for (const segment of segments) {
            const size = segment.length + 1;
            if (bufferChars + size > maxChars && buffer.length > 0) {
                flush();
                keepOverlap();
            }
            buffer.push({ line: segment, lineNo: i + 1 });
            bufferChars += size;
        }
    }

    flush();
    return chunks;
}

function summarizeSnippet(content: string): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (compact.length <= MAX_SNIPPET_CHARS) {
        return compact;
    }
    return `${compact.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function normalizeScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function normalizeRankScore(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return value / (1 + value);
}

function mergeHybrid(
    vectorRows: SearchRow[],
    ftsRows: SearchRow[],
    vectorWeight: number,
    ftsWeight: number,
): MemorySearchHit[] {
    const merged = new Map<string, {
        row: SearchRow;
        vectorScore: number;
        ftsScore: number;
    }>();

    for (const row of vectorRows) {
        const key = `${row.rel_path}#${row.chunk_index}`;
        merged.set(key, {
            row,
            vectorScore: normalizeScore(row.score),
            ftsScore: 0,
        });
    }

    for (const row of ftsRows) {
        const key = `${row.rel_path}#${row.chunk_index}`;
        const current = merged.get(key);
        if (current) {
            current.ftsScore = normalizeRankScore(row.score);
            if (!current.row.content && row.content) {
                current.row = row;
            }
        } else {
            merged.set(key, {
                row,
                vectorScore: 0,
                ftsScore: normalizeRankScore(row.score),
            });
        }
    }

    return Array.from(merged.values())
        .map(({ row, vectorScore, ftsScore }) => ({
            path: row.rel_path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: vectorWeight * vectorScore + ftsWeight * ftsScore,
            snippet: summarizeSnippet(row.content),
            source: row.source_type,
            strategy: 'hybrid' as const,
        }))
        .sort((a, b) => b.score - a.score);
}

async function walkMarkdownFiles(dir: string, files: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            await walkMarkdownFiles(abs, files);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.md')) continue;
        files.push(abs);
    }
}

function buildPgPoolConfig(memoryConfig: AgentMemoryConfig): PoolConfig | null {
    const pg = memoryConfig.pgsql;
    if (pg.connection_string?.trim()) {
        return {
            connectionString: pg.connection_string.trim(),
            ssl: pg.ssl ? { rejectUnauthorized: false } : undefined,
        };
    }

    if (!pg.host || !pg.user || !pg.database) {
        return null;
    }

    return {
        host: pg.host,
        port: pg.port,
        user: pg.user,
        password: pg.password,
        database: pg.database,
        ssl: pg.ssl ? { rejectUnauthorized: false } : undefined,
    };
}

function resolveEmbeddingProviders(config: Config): AgentMemoryEmbeddingProviderConfig[] {
    const configured = config.agent.memory.embedding.providers
        .map((item) => ({ ...item }))
        .filter((item) => item.api_key?.trim());

    if (configured.length > 0) {
        return configured;
    }

    const openaiModel = config.llm.models.find((item) => item.provider === 'openai' && item.api_key?.trim());
    if (!openaiModel) {
        return [];
    }

    return [
        {
            provider: 'openai',
            base_url: openaiModel.base_url,
            model: 'text-embedding-3-small',
            api_key: openaiModel.api_key,
            timeout_ms: 15000,
        },
    ];
}

export class MemoryRuntime {
    private readonly workspacePath: string;
    private readonly config: Config;
    private readonly memoryConfig: AgentMemoryConfig;
    private readonly schemaSql: string;
    private readonly filesTable: string;
    private readonly chunksTable: string;
    private readonly embeddingCacheTable: string;
    private readonly sessionEventsTable: string;
    private readonly embeddingProviders: AgentMemoryEmbeddingProviderConfig[];

    private pool: Pool | null = null;
    private pgReady = false;
    private vectorAvailable = false;
    private sessionEventsAvailable = false;
    private syncInFlight: Promise<void> | null = null;
    private lastSearchSyncAt = 0;
    private syncDebounceTimer: NodeJS.Timeout | null = null;
    private pendingSyncPaths = new Set<string>();
    private readonly embeddingProviderState: EmbeddingProviderState = {
        dimensionMismatch: new Set<string>(),
    };

    private constructor(workspacePath: string, config: Config) {
        this.workspacePath = workspacePath;
        this.config = config;
        this.memoryConfig = config.agent.memory;
        const schemaName = this.memoryConfig.pgsql.schema || 'pomelobot_memory';
        this.schemaSql = quoteIdentifier(schemaName);
        this.filesTable = `${this.schemaSql}.memory_files`;
        this.chunksTable = `${this.schemaSql}.memory_chunks`;
        this.embeddingCacheTable = `${this.schemaSql}.embedding_cache`;
        this.sessionEventsTable = `${this.schemaSql}.dingtalk_session_events`;
        this.embeddingProviders = resolveEmbeddingProviders(config);
    }

    static async create(workspacePath: string, config: Config): Promise<MemoryRuntime> {
        const runtime = new MemoryRuntime(workspacePath, config);
        await runtime.initialize();
        return runtime;
    }

    private async initialize(): Promise<void> {
        if (this.memoryConfig.backend !== 'pgsql' && !this.memoryConfig.pgsql.enabled) {
            return;
        }

        const poolConfig = buildPgPoolConfig(this.memoryConfig);
        if (!poolConfig) {
            console.warn('[Memory] PGSQL backend requested but connection config is incomplete, fallback to filesystem');
            return;
        }

        try {
            this.pool = new Pool(poolConfig);
            await this.pool.query('SELECT 1');
            await this.ensurePgSchema();
            this.pgReady = true;
            await this.syncIncremental({ force: true });
        } catch (error) {
            console.warn('[Memory] PGSQL initialization failed, fallback to filesystem:', error instanceof Error ? error.message : String(error));
            await this.pool?.end().catch(() => undefined);
            this.pool = null;
            this.pgReady = false;
            this.vectorAvailable = false;
            this.sessionEventsAvailable = false;
        }
    }

    canUsePg(): boolean {
        return this.pgReady && this.pool !== null;
    }

    async close(): Promise<void> {
        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = null;
        }
        await this.flushPendingSync();
        if (this.pool) {
            await this.pool.end().catch(() => undefined);
            this.pool = null;
        }
        this.pgReady = false;
        this.vectorAvailable = false;
        this.sessionEventsAvailable = false;
    }

    private async ensurePgSchema(): Promise<void> {
        if (!this.pool) return;

        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.filesTable} (
                scope_key TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                source_type TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                mtime_ms BIGINT NOT NULL,
                size_bytes BIGINT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (scope_key, rel_path)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.chunksTable} (
                id BIGSERIAL PRIMARY KEY,
                scope_key TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                source_type TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                content TEXT NOT NULL,
                chunk_hash TEXT NOT NULL,
                embedding_json TEXT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
                UNIQUE (scope_key, rel_path, chunk_index)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.embeddingCacheTable} (
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (provider, model, content_hash)
            )`
        );

        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ${this.sessionEventsTable} (
                id BIGSERIAL PRIMARY KEY,
                session_key TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata_json JSONB,
                created_at BIGINT NOT NULL,
                inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`
        );
        await this.pool.query(
            `ALTER TABLE ${this.sessionEventsTable}
             ADD COLUMN IF NOT EXISTS metadata_json JSONB`
        );
        await this.pool.query(
            `ALTER TABLE ${this.sessionEventsTable}
             ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
        );

        await this.pool.query(`CREATE INDEX IF NOT EXISTS memory_chunks_scope_idx ON ${this.chunksTable} (scope_key)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS memory_chunks_fts_idx ON ${this.chunksTable} USING GIN (search_vector)`);
        try {
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS dingtalk_session_events_session_idx
                 ON ${this.sessionEventsTable} (session_key, created_at DESC)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS dingtalk_session_events_conversation_idx
                 ON ${this.sessionEventsTable} (conversation_id, created_at DESC)`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS dingtalk_session_events_fts_idx
                 ON ${this.sessionEventsTable}
                 USING GIN (to_tsvector('simple', coalesce(content, '')))`
            );
            this.sessionEventsAvailable = true;
        } catch (error) {
            this.sessionEventsAvailable = false;
            console.warn('[Memory] session events index unavailable, session retrieval disabled:', error instanceof Error ? error.message : String(error));
        }

        if (!this.memoryConfig.embedding.enabled) {
            this.vectorAvailable = false;
            return;
        }

        try {
            await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
            await this.pool.query(`ALTER TABLE ${this.chunksTable} ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_VECTOR_DIMENSIONS})`);
            await this.pool.query(`ALTER TABLE ${this.embeddingCacheTable} ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_VECTOR_DIMENSIONS})`);
            await this.pool.query(
                `UPDATE ${this.chunksTable}
                 SET embedding = NULL
                 WHERE embedding IS NOT NULL
                   AND vector_dims(embedding) <> ${DEFAULT_VECTOR_DIMENSIONS}`
            );
            await this.pool.query(
                `UPDATE ${this.embeddingCacheTable}
                 SET embedding = NULL
                 WHERE embedding IS NOT NULL
                   AND vector_dims(embedding) <> ${DEFAULT_VECTOR_DIMENSIONS}`
            );
            await this.pool.query(
                `ALTER TABLE ${this.chunksTable}
                 ALTER COLUMN embedding TYPE vector(${DEFAULT_VECTOR_DIMENSIONS})
                 USING CASE
                    WHEN embedding IS NULL THEN NULL
                    WHEN vector_dims(embedding) = ${DEFAULT_VECTOR_DIMENSIONS} THEN embedding::vector(${DEFAULT_VECTOR_DIMENSIONS})
                    ELSE NULL
                 END`
            );
            await this.pool.query(
                `ALTER TABLE ${this.embeddingCacheTable}
                 ALTER COLUMN embedding TYPE vector(${DEFAULT_VECTOR_DIMENSIONS})
                 USING CASE
                    WHEN embedding IS NULL THEN NULL
                    WHEN vector_dims(embedding) = ${DEFAULT_VECTOR_DIMENSIONS} THEN embedding::vector(${DEFAULT_VECTOR_DIMENSIONS})
                    ELSE NULL
                 END`
            );
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS memory_chunks_embedding_ivf_idx
                 ON ${this.chunksTable} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
            );
            this.vectorAvailable = true;
        } catch (error) {
            this.vectorAvailable = false;
            console.warn('[Memory] pgvector unavailable, vector retrieval disabled:', error instanceof Error ? error.message : String(error));
        }
    }

    async syncIncremental(options?: { force?: boolean; onlyPaths?: string[] }): Promise<void> {
        if (!this.canUsePg()) {
            return;
        }

        if (this.syncInFlight) {
            return this.syncInFlight;
        }

        this.syncInFlight = this.runIncrementalSync(options)
            .finally(() => {
                this.syncInFlight = null;
            });
        return this.syncInFlight;
    }

    private schedulePathSync(paths: string[]): void {
        if (!this.canUsePg()) {
            return;
        }

        for (const item of paths) {
            const abs = resolve(item);
            if (abs.startsWith(this.workspacePath)) {
                this.pendingSyncPaths.add(abs);
            }
        }

        if (this.pendingSyncPaths.size === 0) {
            return;
        }

        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
        }

        this.syncDebounceTimer = setTimeout(() => {
            this.syncDebounceTimer = null;
            void this.flushPendingSync();
        }, TRANSCRIPT_SYNC_DEBOUNCE_MS);
    }

    private async flushPendingSync(): Promise<void> {
        if (!this.canUsePg()) {
            this.pendingSyncPaths.clear();
            return;
        }
        if (this.pendingSyncPaths.size === 0) {
            return;
        }

        const paths = Array.from(this.pendingSyncPaths);
        this.pendingSyncPaths.clear();
        await this.syncIncremental({ onlyPaths: paths, force: true })
            .catch((error) => {
                console.warn('[Memory] deferred incremental sync failed:', error instanceof Error ? error.message : String(error));
            });
    }

    private async runIncrementalSync(options?: { force?: boolean; onlyPaths?: string[] }): Promise<void> {
        if (!this.pool) return;

        const onlyPaths = options?.onlyPaths
            ?.map((item) => resolve(item))
            .filter((item) => item.startsWith(this.workspacePath));

        const files = onlyPaths && onlyPaths.length > 0
            ? onlyPaths
            : await this.listIndexableFiles();

        const existing = await this.readIndexedFileMeta();
        const seen = new Set<string>();

        for (const absPath of files) {
            let fileStat;
            try {
                fileStat = await stat(absPath);
            } catch {
                continue;
            }
            if (!fileStat.isFile()) {
                continue;
            }

            const relPath = normalizeRelPath(this.workspacePath, absPath);
            const scopeKey = inferScopeFromRelPath(relPath);
            const sourceType = inferSourceType(relPath);
            const key = `${scopeKey}\0${relPath}`;
            seen.add(key);

            const prev = existing.get(key);
            const mtimeMs = Math.round(fileStat.mtimeMs);
            const sizeBytes = Math.round(fileStat.size);
            const unchanged = !options?.force
                && prev
                && prev.mtime_ms === mtimeMs
                && prev.size_bytes === sizeBytes;
            if (unchanged) {
                continue;
            }

            await this.indexOneFile({
                absPath,
                relPath,
                scopeKey,
                sourceType,
                mtimeMs,
                sizeBytes,
                previousHash: prev?.content_hash,
            });
        }

        if (onlyPaths && onlyPaths.length > 0) {
            return;
        }

        for (const [key, row] of existing.entries()) {
            if (seen.has(key)) continue;
            await this.deleteIndexedFile(row.scope_key, row.rel_path);
        }
    }

    private async listIndexableFiles(): Promise<string[]> {
        const files: string[] = [];
        const longTermMain = join(this.workspacePath, 'MEMORY.md');
        const memoryDir = join(this.workspacePath, 'memory');

        if (existsSync(longTermMain)) {
            files.push(longTermMain);
        }

        if (existsSync(memoryDir)) {
            await walkMarkdownFiles(memoryDir, files);
        }

        return files;
    }

    private async readIndexedFileMeta(): Promise<Map<string, FileMetaRow>> {
        const map = new Map<string, FileMetaRow>();
        if (!this.pool) return map;

        const result = await this.pool.query<FileMetaRow>(
            `SELECT scope_key, rel_path, content_hash, mtime_ms, size_bytes FROM ${this.filesTable}`
        );

        for (const row of result.rows) {
            map.set(`${row.scope_key}\0${row.rel_path}`, row);
        }
        return map;
    }

    private async deleteIndexedFile(scopeKey: string, relPath: string): Promise<void> {
        if (!this.pool) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM ${this.chunksTable} WHERE scope_key = $1 AND rel_path = $2`, [scopeKey, relPath]);
            await client.query(`DELETE FROM ${this.filesTable} WHERE scope_key = $1 AND rel_path = $2`, [scopeKey, relPath]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async indexOneFile(params: {
        absPath: string;
        relPath: string;
        scopeKey: string;
        sourceType: MemorySourceType;
        mtimeMs: number;
        sizeBytes: number;
        previousHash?: string;
    }): Promise<void> {
        if (!this.pool) return;

        const content = await readFile(params.absPath, 'utf-8');
        const contentHash = sha256(content);

        if (params.previousHash && params.previousHash === contentHash) {
            await this.pool.query(
                `INSERT INTO ${this.filesTable} (scope_key, rel_path, source_type, content_hash, mtime_ms, size_bytes, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (scope_key, rel_path)
                 DO UPDATE SET
                   source_type = EXCLUDED.source_type,
                   content_hash = EXCLUDED.content_hash,
                   mtime_ms = EXCLUDED.mtime_ms,
                   size_bytes = EXCLUDED.size_bytes,
                   updated_at = NOW()`,
                [
                    params.scopeKey,
                    params.relPath,
                    params.sourceType,
                    contentHash,
                    params.mtimeMs,
                    params.sizeBytes,
                ]
            );
            return;
        }

        const chunks = chunkMarkdown(content);
        const embeddings = (this.memoryConfig.embedding.enabled && (this.memoryConfig.retrieval.mode === 'vector' || this.memoryConfig.retrieval.mode === 'hybrid'))
            ? await this.embedChunks(chunks.map((chunk) => ({ hash: chunk.hash, text: chunk.text })))
            : new Map<string, number[]>();

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `INSERT INTO ${this.filesTable} (scope_key, rel_path, source_type, content_hash, mtime_ms, size_bytes, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())
                 ON CONFLICT (scope_key, rel_path)
                 DO UPDATE SET
                   source_type = EXCLUDED.source_type,
                   content_hash = EXCLUDED.content_hash,
                   mtime_ms = EXCLUDED.mtime_ms,
                   size_bytes = EXCLUDED.size_bytes,
                   updated_at = NOW()`,
                [
                    params.scopeKey,
                    params.relPath,
                    params.sourceType,
                    contentHash,
                    params.mtimeMs,
                    params.sizeBytes,
                ]
            );

            await client.query(`DELETE FROM ${this.chunksTable} WHERE scope_key = $1 AND rel_path = $2`, [
                params.scopeKey,
                params.relPath,
            ]);

            for (const chunk of chunks) {
                const embedding = embeddings.get(chunk.hash);
                const embeddingJson = embedding ? JSON.stringify(embedding) : null;
                if (this.vectorAvailable) {
                    await client.query(
                        `INSERT INTO ${this.chunksTable}
                         (scope_key, rel_path, chunk_index, source_type, start_line, end_line, content, chunk_hash, embedding_json, embedding, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, NOW())`,
                        [
                            params.scopeKey,
                            params.relPath,
                            chunk.chunkIndex,
                            params.sourceType,
                            chunk.startLine,
                            chunk.endLine,
                            chunk.text,
                            chunk.hash,
                            embeddingJson,
                            embedding ? toVectorLiteral(embedding) : null,
                        ]
                    );
                } else {
                    await client.query(
                        `INSERT INTO ${this.chunksTable}
                         (scope_key, rel_path, chunk_index, source_type, start_line, end_line, content, chunk_hash, embedding_json, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
                        [
                            params.scopeKey,
                            params.relPath,
                            chunk.chunkIndex,
                            params.sourceType,
                            chunk.startLine,
                            chunk.endLine,
                            chunk.text,
                            chunk.hash,
                            embeddingJson,
                        ]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async embedChunks(entries: Array<{ hash: string; text: string }>): Promise<Map<string, number[]>> {
        const result = new Map<string, number[]>();
        for (const entry of entries) {
            if (!entry.text.trim()) {
                continue;
            }
            const embedding = await this.getOrCreateEmbedding(entry.text, entry.hash);
            if (embedding && embedding.length > 0) {
                result.set(entry.hash, embedding);
            }
        }
        return result;
    }

    private async getOrCreateEmbedding(text: string, contentHash: string): Promise<number[] | null> {
        if (!this.pool || this.embeddingProviders.length === 0) {
            return null;
        }
        if (!text.trim()) {
            return null;
        }

        for (const provider of this.embeddingProviders) {
            const providerKey = `${provider.provider}:${provider.model}`;
            if (this.embeddingProviderState.dimensionMismatch.has(providerKey)) {
                continue;
            }

            if (this.memoryConfig.embedding.cache_enabled) {
                const cached = await this.pool.query<{ embedding_json: string }>(
                    `SELECT embedding_json
                     FROM ${this.embeddingCacheTable}
                     WHERE provider = $1 AND model = $2 AND content_hash = $3
                     LIMIT 1`,
                    [provider.provider, provider.model, contentHash]
                );

                if (cached.rows[0]?.embedding_json) {
                    try {
                        const parsed = JSON.parse(cached.rows[0].embedding_json) as unknown;
                        if (Array.isArray(parsed)) {
                            const vector = parsed.map((value) => Number(value));
                            if (isValidEmbedding(vector)) {
                                return vector;
                            }
                            console.warn(
                                `[Memory] ignore cached embedding with invalid dimensions (${vector.length}), expected ${DEFAULT_VECTOR_DIMENSIONS}`
                            );
                        } else {
                            console.warn(
                                `[Memory] ignore cached embedding with invalid dimensions (unknown), expected ${DEFAULT_VECTOR_DIMENSIONS}`
                            );
                        }
                        await this.pool.query(
                            `DELETE FROM ${this.embeddingCacheTable}
                             WHERE provider = $1 AND model = $2 AND content_hash = $3`,
                            [provider.provider, provider.model, contentHash]
                        ).catch(() => undefined);
                    } catch {
                        // ignore invalid cache and fallback to provider request
                    }
                }
            }

            try {
                const embedding = await this.requestEmbedding(text, provider);
                if (!isValidEmbedding(embedding)) {
                    console.warn(
                        `[Memory] embedding dimensions mismatch for ${provider.provider}/${provider.model}: got ${embedding.length}, expected ${DEFAULT_VECTOR_DIMENSIONS}`
                    );
                    this.embeddingProviderState.dimensionMismatch.add(providerKey);
                    continue;
                }

                await this.pool.query(
                    `INSERT INTO ${this.embeddingCacheTable}
                     (provider, model, content_hash, embedding_json, embedding, updated_at)
                     VALUES ($1, $2, $3, $4, $5::vector, NOW())
                     ON CONFLICT (provider, model, content_hash)
                     DO UPDATE SET
                       embedding_json = EXCLUDED.embedding_json,
                       embedding = EXCLUDED.embedding,
                       updated_at = NOW()`,
                    [
                        provider.provider,
                        provider.model,
                        contentHash,
                        JSON.stringify(embedding),
                        this.vectorAvailable ? toVectorLiteral(embedding) : null,
                    ]
                ).catch(async () => {
                    await this.pool?.query(
                        `INSERT INTO ${this.embeddingCacheTable}
                         (provider, model, content_hash, embedding_json, updated_at)
                         VALUES ($1, $2, $3, $4, NOW())
                         ON CONFLICT (provider, model, content_hash)
                         DO UPDATE SET
                           embedding_json = EXCLUDED.embedding_json,
                           updated_at = NOW()`,
                        [provider.provider, provider.model, contentHash, JSON.stringify(embedding)]
                    );
                });

                return embedding;
            } catch (error) {
                console.warn('[Memory] embedding provider failed, try fallback:', error instanceof Error ? error.message : String(error));
            }
        }

        return null;
    }

    private async requestEmbedding(
        text: string,
        provider: AgentMemoryEmbeddingProviderConfig,
    ): Promise<number[]> {
        const base = provider.base_url.replace(/\/$/, '');
        const endpoint = `${base}/embeddings`;
        const timeoutMs = provider.timeout_ms > 0 ? provider.timeout_ms : 15000;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const requestJson = async (body: unknown) => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${provider.api_key}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const rawText = await response.text();
            let parsedJson: unknown = null;
            try {
                parsedJson = rawText ? JSON.parse(rawText) : null;
            } catch {
                parsedJson = null;
            }
            return { response, rawText, parsedJson };
        };

        const extractVector = (payload: unknown): number[] | null => {
            if (!payload || typeof payload !== 'object') {
                return null;
            }
            const record = payload as Record<string, unknown>;

            const openaiVector = (record.data as Array<{ embedding?: unknown }> | undefined)?.[0]?.embedding;
            if (Array.isArray(openaiVector) && openaiVector.length > 0) {
                return openaiVector.map((value) => Number(value));
            }

            const output = record.output as Record<string, unknown> | undefined;
            const outputEmbeddings = output?.embeddings as Array<{ embedding?: unknown }> | undefined;
            const dashscopeVector = outputEmbeddings?.[0]?.embedding;
            if (Array.isArray(dashscopeVector) && dashscopeVector.length > 0) {
                return dashscopeVector.map((value) => Number(value));
            }

            return null;
        };

        try {
            const primary = await requestJson({
                model: provider.model,
                input: [text],
                dimensions: DEFAULT_VECTOR_DIMENSIONS,
                encoding_format: 'float',
            });

            if (primary.response.ok) {
                const vector = extractVector(primary.parsedJson);
                if (vector && vector.length > 0) {
                    return vector;
                }
                throw new Error('embedding response missing vector data');
            }

            const primaryErrorSnippet = primary.rawText.slice(0, 300);
            const shouldTryDashScopeFallback = primary.response.status === 400 && (
                primaryErrorSnippet.includes('input.texts should not be null')
                || primaryErrorSnippet.includes('InvalidParameter')
            );

            if (shouldTryDashScopeFallback) {
                const fallback = await requestJson({
                    model: provider.model,
                    input: {
                        texts: [text],
                    },
                    dimensions: DEFAULT_VECTOR_DIMENSIONS,
                    encoding_format: 'float',
                });
                if (fallback.response.ok) {
                    const vector = extractVector(fallback.parsedJson);
                    if (vector && vector.length > 0) {
                        return vector;
                    }
                    throw new Error('embedding response missing vector data');
                }
                throw new Error(`embedding request failed (${fallback.response.status}): ${fallback.rawText.slice(0, 200)}`);
            }

            throw new Error(`embedding request failed (${primary.response.status}): ${primaryErrorSnippet.slice(0, 200)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    private async maybeSyncBeforeSearch(): Promise<void> {
        if (!this.canUsePg()) {
            return;
        }
        if (!this.memoryConfig.retrieval.sync_on_search) {
            return;
        }

        const now = Date.now();
        if (now - this.lastSearchSyncAt < this.memoryConfig.retrieval.sync_min_interval_ms) {
            return;
        }

        await this.syncIncremental();
        this.lastSearchSyncAt = now;
    }

    async search(query: string, scope: MemoryScope): Promise<MemorySearchHit[]> {
        const fileKeywordFallback = async () => await this.searchFromFiles(query, scope);

        if (this.memoryConfig.backend !== 'pgsql' || !this.canUsePg()) {
            return fileKeywordFallback();
        }

        await this.maybeSyncBeforeSearch();

        const mode = this.memoryConfig.retrieval.mode;
        const maxResults = this.memoryConfig.retrieval.max_results;
        const minScore = this.memoryConfig.retrieval.min_score;
        const keywordFallback = async () => {
            const rows = await this.searchPgKeywordUnified(query, scope.key, maxResults);
            if (rows.length > 0) {
                return rows
                    .map((row) => this.rowToHit(row, 'keyword'))
                    .filter((item) => item.score >= minScore)
                    .slice(0, maxResults);
            }
            return fileKeywordFallback();
        };

        if (mode === 'keyword') {
            return keywordFallback();
        }

        if (mode === 'fts') {
            const rows = await this.searchPgFtsUnified(query, scope.key, maxResults);
            if (rows.length === 0) {
                return keywordFallback();
            }
            return rows
                .map((row) => this.rowToHit(row, 'fts'))
                .filter((item) => normalizeRankScore(item.score) >= minScore)
                .map((item) => ({ ...item, score: normalizeRankScore(item.score) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, maxResults);
        }

        if (mode === 'vector') {
            const candidates = Math.max(
                maxResults,
                Math.floor(maxResults * this.memoryConfig.retrieval.hybrid_candidate_multiplier),
            );
            const [vectorRows, sessionRows] = await Promise.all([
                this.searchPgVector(query, scope.key, candidates),
                this.searchPgSessionEventsFts(query, scope.key, candidates),
            ]);
            if (vectorRows.length === 0) {
                const ftsRows = await this.searchPgFtsUnified(query, scope.key, maxResults);
                if (ftsRows.length === 0) {
                    return keywordFallback();
                }
                return ftsRows
                    .map((row) => this.rowToHit(row, 'fts'))
                    .map((item) => ({ ...item, score: normalizeRankScore(item.score) }))
                    .filter((item) => item.score >= minScore)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, maxResults);
            }

            if (sessionRows.length > 0) {
                const merged = mergeHybrid(
                    vectorRows,
                    sessionRows,
                    this.memoryConfig.retrieval.hybrid_vector_weight,
                    this.memoryConfig.retrieval.hybrid_fts_weight,
                ).map((item) => ({ ...item, strategy: 'vector' as const }));
                return merged
                    .filter((item) => item.score >= minScore)
                    .slice(0, maxResults);
            }

            return vectorRows
                .map((row) => this.rowToHit(row, 'vector'))
                .filter((item) => item.score >= minScore)
                .slice(0, maxResults);
        }

        const candidates = Math.max(
            maxResults,
            Math.floor(maxResults * this.memoryConfig.retrieval.hybrid_candidate_multiplier),
        );
        const [ftsRows, vectorRows] = await Promise.all([
            this.searchPgFtsUnified(query, scope.key, candidates),
            this.searchPgVector(query, scope.key, candidates),
        ]);

        if (vectorRows.length === 0 && ftsRows.length === 0) {
            return keywordFallback();
        }

        const merged = mergeHybrid(
            vectorRows,
            ftsRows,
            this.memoryConfig.retrieval.hybrid_vector_weight,
            this.memoryConfig.retrieval.hybrid_fts_weight,
        );

        return merged
            .filter((item) => item.score >= minScore)
            .slice(0, maxResults);
    }

    private shouldSearchSessionEvents(): boolean {
        return this.canUsePg()
            && this.sessionEventsAvailable
            && this.memoryConfig.retrieval.include_session_events;
    }

    private getSessionEventsLimit(limit: number): number {
        const configured = this.memoryConfig.retrieval.session_events_max_results;
        return Math.max(1, Math.min(Math.max(1, limit), configured));
    }

    private mergeRows(rows: SearchRow[], limit: number): SearchRow[] {
        if (rows.length === 0) {
            return [];
        }
        const deduped = new Map<string, SearchRow>();
        for (const row of sortRowsByScore(rows)) {
            const key = `${row.rel_path}#${row.chunk_index}`;
            if (!deduped.has(key)) {
                deduped.set(key, row);
                if (deduped.size >= limit) {
                    break;
                }
            }
        }
        return Array.from(deduped.values());
    }

    private rowToHit(row: SearchRow, strategy: MemorySearchHit['strategy']): MemorySearchHit {
        return {
            path: row.rel_path,
            startLine: row.start_line,
            endLine: row.end_line,
            score: row.score,
            snippet: summarizeSnippet(row.content),
            source: row.source_type,
            strategy,
        };
    }

    private async searchPgKeywordUnified(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        const [chunkRows, sessionRows] = await Promise.all([
            this.searchPgKeyword(query, scopeKey, limit),
            this.searchPgSessionEventsKeyword(query, scopeKey, limit),
        ]);
        return this.mergeRows([...chunkRows, ...sessionRows], limit);
    }

    private async searchPgKeyword(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool) return [];

        const result = await this.pool.query<SearchRow>(
            `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                    CASE
                        WHEN position(lower($2) in lower(content)) > 0
                        THEN 1.0 / (1 + position(lower($2) in lower(content)))
                        ELSE 0
                    END AS score
             FROM ${this.chunksTable}
             WHERE scope_key = $1
               AND content ILIKE '%' || $2 || '%'
             ORDER BY score DESC, updated_at DESC
             LIMIT $3`,
            [scopeKey, query, limit]
        );

        return result.rows;
    }

    private async searchPgSessionEventsKeyword(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.shouldSearchSessionEvents()) {
            return [];
        }

        const sessionLimit = this.getSessionEventsLimit(limit);
        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT
                    ('session_events/' || session_key || '/' || conversation_id || '/event-' || id::text) AS rel_path,
                    0 AS chunk_index,
                    1 AS start_line,
                    1 AS end_line,
                    ('[' || role || '] ' || content) AS content,
                    'session'::text AS source_type,
                    CASE
                        WHEN position(lower($2) in lower(content)) > 0
                        THEN 1.0 / (1 + position(lower($2) in lower(content)))
                        ELSE 0
                    END AS score
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND content ILIKE '%' || $2 || '%'
                 ORDER BY score DESC, created_at DESC
                 LIMIT $3`,
                [scopeKey, query, sessionLimit]
            );
            return result.rows;
        } catch (error) {
            this.handleSessionSearchError(error, 'keyword');
            return [];
        }
    }

    private async searchPgFtsUnified(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        const [chunkRows, sessionRows] = await Promise.all([
            this.searchPgFts(query, scopeKey, limit),
            this.searchPgSessionEventsFts(query, scopeKey, limit),
        ]);
        return this.mergeRows([...chunkRows, ...sessionRows], limit);
    }

    private async searchPgFts(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool) return [];

        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                        ts_rank_cd(search_vector, websearch_to_tsquery('simple', $2)) AS score
                 FROM ${this.chunksTable}
                 WHERE scope_key = $1
                   AND search_vector @@ websearch_to_tsquery('simple', $2)
                 ORDER BY score DESC, updated_at DESC
                 LIMIT $3`,
                [scopeKey, query, limit]
            );

            if (result.rows.length > 0) {
                return result.rows;
            }
        } catch {
            // fall through to keyword fallback query
        }

        return this.searchPgKeyword(query, scopeKey, limit);
    }

    private async searchPgSessionEventsFts(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.shouldSearchSessionEvents()) {
            return [];
        }

        const sessionLimit = this.getSessionEventsLimit(limit);
        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT
                    ('session_events/' || session_key || '/' || conversation_id || '/event-' || id::text) AS rel_path,
                    0 AS chunk_index,
                    1 AS start_line,
                    1 AS end_line,
                    ('[' || role || '] ' || content) AS content,
                    'session'::text AS source_type,
                    ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', $2)) AS score
                 FROM ${this.sessionEventsTable}
                 WHERE session_key = $1
                   AND to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $2)
                 ORDER BY score DESC, created_at DESC
                 LIMIT $3`,
                [scopeKey, query, sessionLimit]
            );

            if (result.rows.length > 0) {
                return result.rows;
            }
        } catch (error) {
            this.handleSessionSearchError(error, 'fts');
            return this.searchPgSessionEventsKeyword(query, scopeKey, limit);
        }

        return this.searchPgSessionEventsKeyword(query, scopeKey, limit);
    }

    private handleSessionSearchError(error: unknown, mode: 'keyword' | 'fts'): void {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (code === '42P01' || code === '42703') {
            this.sessionEventsAvailable = false;
        }
        console.warn(`[Memory] session event ${mode} search failed:`, error instanceof Error ? error.message : String(error));
    }

    private async searchPgVector(query: string, scopeKey: string, limit: number): Promise<SearchRow[]> {
        if (!this.pool || !this.vectorAvailable || !this.memoryConfig.embedding.enabled) {
            return [];
        }

        const queryHash = sha256(`query:${query}`);
        const embedding = await this.getOrCreateEmbedding(query, queryHash);
        if (!embedding || embedding.length === 0) {
            return [];
        }

        try {
            const result = await this.pool.query<SearchRow>(
                `SELECT rel_path, chunk_index, start_line, end_line, content, source_type,
                        (1 - (embedding <=> $2::vector)) AS score
                 FROM ${this.chunksTable}
                 WHERE scope_key = $1
                   AND embedding IS NOT NULL
                 ORDER BY embedding <=> $2::vector ASC
                 LIMIT $3`,
                [scopeKey, toVectorLiteral(embedding), limit]
            );

            return result.rows;
        } catch (error) {
            this.vectorAvailable = false;
            console.warn('[Memory] vector search disabled after query failure:', error instanceof Error ? error.message : String(error));
            return [];
        }
    }

    async save(content: string, target: 'daily' | 'long-term', scope: MemoryScope): Promise<MemorySaveResult> {
        const now = new Date();
        const timestamp = formatTimeStamp(now);
        const entry = `\n[${timestamp}] ${content}\n`;

        const dailyDate = formatLocalDate(now);
        const paths = this.resolveScopePaths(scope);
        const targetPath = target === 'daily'
            ? join(paths.dailyDir, `${dailyDate}.md`)
            : paths.longTermPath;

        if (!existsSync(paths.dailyDir)) {
            mkdirSync(paths.dailyDir, { recursive: true });
        }

        if (!existsSync(targetPath)) {
            const header = target === 'daily'
                ? `# Daily Memory - ${dailyDate} (${scope.key})\n`
                : `# Long-term Memory (${scope.key})\n\n`;
            writeFileSync(targetPath, header, 'utf-8');
        }

        await appendFile(targetPath, entry, 'utf-8');

        if (this.canUsePg()) {
            await this.syncIncremental({ onlyPaths: [targetPath], force: true });
        }

        return {
            path: targetPath,
            scope: scope.key,
        };
    }

    async appendTranscript(scope: MemoryScope, role: 'user' | 'assistant', content: string): Promise<void> {
        if (!this.memoryConfig.transcript.enabled) {
            return;
        }

        const text = content.trim();
        if (!text) {
            return;
        }

        const maxChars = this.memoryConfig.transcript.max_chars_per_entry;
        const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;

        const now = new Date();
        const dailyDate = formatLocalDate(now);
        const timestamp = formatTimeStamp(now);
        const transcriptDir = join(this.workspacePath, 'memory', 'scopes', scope.key, 'transcripts');
        const transcriptPath = join(transcriptDir, `${dailyDate}.md`);

        if (!existsSync(transcriptDir)) {
            mkdirSync(transcriptDir, { recursive: true });
        }

        if (!existsSync(transcriptPath)) {
            writeFileSync(transcriptPath, `# Session Transcript - ${dailyDate} (${scope.key})\n`, 'utf-8');
        }

        const roleLabel = role === 'assistant' ? 'assistant' : 'user';
        await appendFile(transcriptPath, `\n[${timestamp}] [${roleLabel}] ${clipped}\n`, 'utf-8');

        if (this.canUsePg()) {
            this.schedulePathSync([transcriptPath]);
        }
    }

    private resolveScopePaths(scope: MemoryScope): { dailyDir: string; longTermPath: string } {
        if (scope.key === 'main') {
            return {
                dailyDir: join(this.workspacePath, 'memory'),
                longTermPath: join(this.workspacePath, 'MEMORY.md'),
            };
        }

        const scopeRoot = join(this.workspacePath, 'memory', 'scopes', scope.key);
        return {
            dailyDir: scopeRoot,
            longTermPath: join(scopeRoot, 'LONG_TERM.md'),
        };
    }

    private async searchFromFiles(query: string, scope: MemoryScope): Promise<MemorySearchHit[]> {
        const normalizedQuery = query.toLowerCase();
        const results: MemorySearchHit[] = [];

        const scopePaths = this.resolveScopePaths(scope);
        const files: string[] = [];

        if (existsSync(scopePaths.longTermPath)) {
            files.push(scopePaths.longTermPath);
        }

        if (existsSync(scopePaths.dailyDir)) {
            if (scope.key === 'main') {
                const entries = await readdir(scopePaths.dailyDir, { withFileTypes: true }).catch(() => []);
                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
                    files.push(join(scopePaths.dailyDir, entry.name));
                }
            } else {
                await walkMarkdownFiles(scopePaths.dailyDir, files);
            }
        }

        if (this.memoryConfig.transcript.enabled && scope.key === 'main') {
            const transcriptDir = join(this.workspacePath, 'memory', 'scopes', scope.key, 'transcripts');
            if (existsSync(transcriptDir)) {
                await walkMarkdownFiles(transcriptDir, files);
            }
        }

        for (const file of files) {
            const relPath = normalizeRelPath(this.workspacePath, file);
            const source = inferSourceType(relPath);
            const content = await readFile(file, 'utf-8').catch(() => '');
            if (!content) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i] || '';
                const lowerLine = line.toLowerCase();
                const position = lowerLine.indexOf(normalizedQuery);
                if (position < 0) continue;
                results.push({
                    path: relPath,
                    startLine: i + 1,
                    endLine: i + 1,
                    score: 1 / (1 + position),
                    snippet: summarizeSnippet(line),
                    source,
                    strategy: 'keyword',
                });
            }
        }

        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, this.memoryConfig.retrieval.max_results);
    }
}

const runtimeCache = new Map<string, Promise<MemoryRuntime>>();

function buildRuntimeCacheKey(workspacePath: string, config: Config): string {
    return `${workspacePath}:${JSON.stringify(config.agent.memory)}`;
}

export async function getMemoryRuntime(workspacePath: string, config: Config): Promise<MemoryRuntime> {
    const normalizedWorkspace = resolve(workspacePath);
    const cacheKey = buildRuntimeCacheKey(normalizedWorkspace, config);
    const cached = runtimeCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const created = MemoryRuntime.create(normalizedWorkspace, config).catch((error) => {
        runtimeCache.delete(cacheKey);
        throw error;
    });

    runtimeCache.set(cacheKey, created);
    return created;
}
