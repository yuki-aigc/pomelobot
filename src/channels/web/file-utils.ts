import path from 'node:path';

export const MAX_WEB_REPLY_FILE_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.tar': 'application/x-tar',
    '.tgz': 'application/gzip',
    '.gz': 'application/gzip',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.yaml': 'application/yaml; charset=utf-8',
    '.yml': 'application/yaml; charset=utf-8',
    '.zip': 'application/zip',
};

export function isPathInsideDir(filePath: string, dirPath: string): boolean {
    const normalizedDir = path.resolve(dirPath);
    const normalizedFile = path.resolve(filePath);
    return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}${path.sep}`);
}

export function resolvePathFromWorkspace(workspaceRoot: string, rawPath: string): string {
    const candidate = rawPath.trim();
    if (!candidate) {
        throw new Error('path 不能为空');
    }
    if (path.isAbsolute(candidate)) {
        return path.resolve(candidate);
    }
    if (candidate.startsWith('workspace/')) {
        return path.resolve(process.cwd(), candidate);
    }
    return path.resolve(workspaceRoot, candidate);
}

export function sanitizeFileName(fileName: string): string {
    return fileName
        .trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || `reply-${Date.now()}.txt`;
}

export function guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

export function buildAttachmentBasePath(uiPath: string): string {
    const trimmed = uiPath.trim();
    if (!trimmed || trimmed === '/') {
        return '/attachments';
    }
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return `${normalized.replace(/\/+$/, '')}/attachments`;
}

export function buildContentDisposition(fileName: string): string {
    const asciiFallback = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_') || 'download';
    const encoded = encodeURIComponent(fileName);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
