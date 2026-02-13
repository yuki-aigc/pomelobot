import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMemoryConfig } from '../../config.js';
import type { MemoryScope } from '../memory-scope.js';

export interface MemoryStoreLayerSaveResult {
    path: string;
    scope: string;
}

export interface MemoryStorePaths {
    scopeRoot: string;
    dailyDir: string;
    longTermPath: string;
    heartbeatPath: string;
}

export interface MemoryStoreLayerDeps {
    workspacePath: string;
    memoryConfig: AgentMemoryConfig;
    canUsePg: () => boolean;
    syncIncremental: (options?: { force?: boolean; onlyPaths?: string[] }) => Promise<void>;
    schedulePathSync: (paths: string[]) => void;
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

export class MemoryStoreLayer {
    constructor(private readonly deps: MemoryStoreLayerDeps) {}

    resolveScopePaths(scope: MemoryScope): MemoryStorePaths {
        const { workspacePath } = this.deps;
        if (scope.key === 'main') {
            const scopeRoot = join(workspacePath, 'memory', 'scopes', 'main');
            return {
                scopeRoot,
                dailyDir: join(workspacePath, 'memory'),
                longTermPath: join(workspacePath, 'MEMORY.md'),
                heartbeatPath: join(scopeRoot, 'HEARTBEAT.md'),
            };
        }

        const scopeRoot = join(workspacePath, 'memory', 'scopes', scope.key);
        return {
            scopeRoot,
            dailyDir: scopeRoot,
            longTermPath: join(scopeRoot, 'LONG_TERM.md'),
            heartbeatPath: join(scopeRoot, 'HEARTBEAT.md'),
        };
    }

    async save(content: string, target: 'daily' | 'long-term', scope: MemoryScope): Promise<MemoryStoreLayerSaveResult> {
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

        if (this.deps.canUsePg()) {
            await this.deps.syncIncremental({ onlyPaths: [targetPath], force: true });
        }

        return {
            path: targetPath,
            scope: scope.key,
        };
    }

    async saveHeartbeat(content: string, scope: MemoryScope, category?: string): Promise<MemoryStoreLayerSaveResult> {
        const text = content.trim();
        if (!text) {
            throw new Error('heartbeat_save content is empty');
        }

        const now = new Date();
        const timestamp = formatTimeStamp(now);
        const paths = this.resolveScopePaths(scope);
        const heartbeatPath = paths.heartbeatPath;

        if (!existsSync(paths.scopeRoot)) {
            mkdirSync(paths.scopeRoot, { recursive: true });
        }

        if (!existsSync(heartbeatPath)) {
            writeFileSync(heartbeatPath, `# Heartbeat (${scope.key})\n\n`, 'utf-8');
        }

        const normalizedCategory = (category || 'lesson').trim();
        const entry = [
            '',
            `## [${timestamp}] ${normalizedCategory}`,
            text,
            '',
        ].join('\n');
        await appendFile(heartbeatPath, entry, 'utf-8');

        if (this.deps.canUsePg()) {
            await this.deps.syncIncremental({ onlyPaths: [heartbeatPath], force: true });
        }

        return {
            path: heartbeatPath,
            scope: scope.key,
        };
    }

    async appendTranscript(scope: MemoryScope, role: 'user' | 'assistant', content: string): Promise<void> {
        if (!this.deps.memoryConfig.transcript.enabled) {
            return;
        }

        const text = content.trim();
        if (!text) {
            return;
        }

        const maxChars = this.deps.memoryConfig.transcript.max_chars_per_entry;
        const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;

        const now = new Date();
        const dailyDate = formatLocalDate(now);
        const timestamp = formatTimeStamp(now);
        const transcriptDir = join(this.deps.workspacePath, 'memory', 'scopes', scope.key, 'transcripts');
        const transcriptPath = join(transcriptDir, `${dailyDate}.md`);

        if (!existsSync(transcriptDir)) {
            mkdirSync(transcriptDir, { recursive: true });
        }

        if (!existsSync(transcriptPath)) {
            writeFileSync(transcriptPath, `# Session Transcript - ${dailyDate} (${scope.key})\n`, 'utf-8');
        }

        const roleLabel = role === 'assistant' ? 'assistant' : 'user';
        await appendFile(transcriptPath, `\n[${timestamp}] [${roleLabel}] ${clipped}\n`, 'utf-8');

        if (this.deps.canUsePg()) {
            this.deps.schedulePathSync([transcriptPath]);
        }
    }
}
