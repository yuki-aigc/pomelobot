import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

type BootstrapFileName = 'AGENTS.md' | 'AGENT.md' | 'SOUL.md' | 'TOOLS.md' | 'HEARTBEAT.md';
type BootstrapFileScope = 'global' | 'scope';
type BootstrapTopic = 'agents' | 'tools' | 'soul' | 'heartbeat';

interface LoadedBootstrapFile {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    relPath: string;
    scope: BootstrapFileScope;
    missing: boolean;
    truncated: boolean;
    content: string;
}

interface BootstrapFileCandidate {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    scope: BootstrapFileScope;
}

const MIN_BOOTSTRAP_CHARS = 200;
const MAX_BOOTSTRAP_CHARS = 20_000;
const DEFAULT_BOOTSTRAP_MAX_CHARS = 4000;
const INCLUDE_MISSING_FILE_MARKERS = true;
const INCLUDE_TOOLS_MD = true;
const INCLUDE_HEARTBEAT_MD = true;
const SCOPE_SOUL_ENABLED = true;
const SCOPE_TOOLS_ENABLED = true;
const SCOPE_HEARTBEAT_ENABLED = true;

function sanitizeScopePathSegment(scopeKey: string): string {
    const normalized = scopeKey.trim().toLowerCase();
    if (!normalized) {
        return 'main';
    }
    return normalized.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'main';
}

function clipInjectedText(content: string, maxChars: number): { text: string; truncated: boolean } {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxChars) {
        return { text: normalized, truncated: false };
    }
    return {
        text: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`,
        truncated: true,
    };
}

function getBootstrapMaxChars(): number {
    return Math.max(MIN_BOOTSTRAP_CHARS, Math.min(MAX_BOOTSTRAP_CHARS, DEFAULT_BOOTSTRAP_MAX_CHARS));
}

function buildScopedCandidates(
    workspacePath: string,
    scopeKey: string,
    topic: BootstrapTopic,
    fileName: BootstrapFileName,
    scopeEnabled: boolean,
): BootstrapFileCandidate[] {
    const candidates: BootstrapFileCandidate[] = [];
    if (scopeEnabled) {
        const safeScopeKey = sanitizeScopePathSegment(scopeKey);
        candidates.push({
            topic,
            name: fileName,
            absPath: join(workspacePath, 'memory', 'scopes', safeScopeKey, fileName),
            scope: 'scope',
        });
    }

    candidates.push({
        topic,
        name: fileName,
        absPath: join(workspacePath, fileName),
        scope: 'global',
    });

    return candidates;
}

async function readBootstrapFile(params: {
    topic: BootstrapTopic;
    name: BootstrapFileName;
    absPath: string;
    scope: BootstrapFileScope;
    workspacePath: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const relPath = relative(params.workspacePath, params.absPath).replace(/\\/g, '/');
    if (!existsSync(params.absPath)) {
        if (!params.includeMissingFileMarkers) {
            return null;
        }
        return {
            topic: params.topic,
            name: params.name,
            absPath: params.absPath,
            relPath,
            scope: params.scope,
            missing: true,
            truncated: false,
            content: `(文件缺失) ${relPath}`,
        };
    }

    const raw = await readFile(params.absPath, 'utf-8');
    const clipped = clipInjectedText(raw, params.maxChars);
    if (!clipped.text) {
        if (!params.includeMissingFileMarkers) {
            return null;
        }
        return {
            topic: params.topic,
            name: params.name,
            absPath: params.absPath,
            relPath,
            scope: params.scope,
            missing: true,
            truncated: false,
            content: `(文件为空) ${relPath}`,
        };
    }

    return {
        topic: params.topic,
        name: params.name,
        absPath: params.absPath,
        relPath,
        scope: params.scope,
        missing: false,
        truncated: clipped.truncated,
        content: clipped.text,
    };
}

function pickCandidate(candidates: BootstrapFileCandidate[]): BootstrapFileCandidate | null {
    if (candidates.length === 0) {
        return null;
    }
    const firstExisting = candidates.find((candidate) => existsSync(candidate.absPath));
    return firstExisting || candidates[0];
}

function formatBootstrapSection(file: LoadedBootstrapFile): string {
    const title = file.topic.toUpperCase();
    const meta = [
        `path=${file.relPath}`,
        `name=${file.name}`,
        `scope=${file.scope}`,
        `missing=${file.missing ? 'true' : 'false'}`,
        `truncated=${file.truncated ? 'true' : 'false'}`,
    ].join(', ');

    return [
        `## ${title}`,
        `[${meta}]`,
        file.content,
    ].join('\n');
}

async function loadAgentsFile(params: {
    workspacePath: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const candidates: BootstrapFileCandidate[] = [
        {
            topic: 'agents',
            name: 'AGENTS.md',
            absPath: join(params.workspacePath, 'AGENTS.md'),
            scope: 'global',
        },
        {
            topic: 'agents',
            name: 'AGENT.md',
            absPath: join(params.workspacePath, 'AGENT.md'),
            scope: 'global',
        },
    ];
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadSoulFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'soul',
        'SOUL.md',
        SCOPE_SOUL_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadToolsFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    if (!INCLUDE_TOOLS_MD) {
        return null;
    }

    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'tools',
        'TOOLS.md',
        SCOPE_TOOLS_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

async function loadHeartbeatFile(params: {
    workspacePath: string;
    scopeKey: string;
    maxChars: number;
    includeMissingFileMarkers: boolean;
}): Promise<LoadedBootstrapFile | null> {
    if (!INCLUDE_HEARTBEAT_MD) {
        return null;
    }

    const candidates = buildScopedCandidates(
        params.workspacePath,
        params.scopeKey,
        'heartbeat',
        'HEARTBEAT.md',
        SCOPE_HEARTBEAT_ENABLED,
    );
    const picked = pickCandidate(candidates);
    if (!picked) {
        return null;
    }

    return readBootstrapFile({
        topic: picked.topic,
        name: picked.name,
        absPath: picked.absPath,
        scope: picked.scope,
        workspacePath: params.workspacePath,
        maxChars: params.maxChars,
        includeMissingFileMarkers: params.includeMissingFileMarkers,
    });
}

export async function buildPromptBootstrapMessage(params: {
    workspacePath: string;
    scopeKey: string;
}): Promise<{ role: 'user'; content: string } | null> {
    const maxChars = getBootstrapMaxChars();
    const includeMissingFileMarkers = INCLUDE_MISSING_FILE_MARKERS;

    const [agentsFile, toolsFile, soulFile, heartbeatFile] = await Promise.all([
        loadAgentsFile({
            workspacePath: params.workspacePath,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadToolsFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadSoulFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
        loadHeartbeatFile({
            workspacePath: params.workspacePath,
            scopeKey: params.scopeKey,
            maxChars,
            includeMissingFileMarkers,
        }),
    ]);

    const files = [agentsFile, toolsFile, soulFile, heartbeatFile].filter((item): item is LoadedBootstrapFile => Boolean(item));
    if (files.length === 0) {
        return null;
    }

    const header = [
        '【Prompt Bootstrap / 系统上下文转述】',
        '以下内容来自工作区 Markdown 引导文件（参考 OpenClaw 的多文件注入思路）。',
        '规则优先级（高 -> 低）：',
        '1) 平台与运行时硬约束（安全策略、审批、工具白名单/黑名单）',
        '2) 系统提示词中的硬规则',
        '3) 用户当前任务目标与明确约束',
        '4) AGENTS（项目协作与执行规范）',
        '5) TOOLS（工具使用约定）',
        '6) SOUL（身份、语气、偏好边界；可 scope 覆盖）',
        '7) HEARTBEAT（纠错与复盘经验；可 scope 覆盖）',
        '冲突处理：安全/边界冲突按高优先级执行；若仅为风格冲突，优先满足用户当前任务并在 HEARTBEAT 记录纠偏经验。',
    ].join('\n');

    const body = files.map((file) => formatBootstrapSection(file)).join('\n\n');
    return {
        role: 'user',
        content: `${header}\n\n${body}`,
    };
}
