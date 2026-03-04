import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWebConversationContext, queueWebReplyFile } from './context.js';
import {
    MAX_WEB_REPLY_FILE_BYTES,
    isPathInsideDir,
    resolvePathFromWorkspace,
    sanitizeFileName,
} from './file-utils.js';

interface WebToolLogger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}

export function createWebFileReturnTools(
    workspaceRoot: string,
    log?: WebToolLogger,
) {
    const workspaceTmpRoot = path.resolve(workspaceRoot, 'tmp');

    const webWriteTmpFile = tool(
        async ({ fileName, content }: { fileName: string; content: string }) => {
            const context = getWebConversationContext();
            if (!context) {
                return '❌ 当前不是 Web 会话，无法使用 web_write_tmp_file。';
            }
            const safeName = sanitizeFileName(fileName);
            const targetPath = path.resolve(workspaceTmpRoot, safeName);
            if (!isPathInsideDir(targetPath, workspaceTmpRoot)) {
                return '❌ 文件路径非法，只允许写入 workspace/tmp。';
            }

            await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
            await fsPromises.writeFile(targetPath, content, 'utf8');

            const stat = await fsPromises.stat(targetPath);
            if (stat.size <= 0) {
                return `⚠️ 文件写入成功但为空: ${targetPath}`;
            }
            if (stat.size > MAX_WEB_REPLY_FILE_BYTES) {
                return `⚠️ 文件已写入但超过 ${Math.floor(MAX_WEB_REPLY_FILE_BYTES / 1024 / 1024)}MB，不能回传: ${targetPath}`;
            }
            queueWebReplyFile(targetPath);
            return `✅ 文件已写入并登记回传: ${targetPath}`;
        },
        {
            name: 'web_write_tmp_file',
            description: '将文本内容写入 workspace/tmp 下文件并登记为待回传附件（仅 Web 会话可用）。',
            schema: z.object({
                fileName: z.string().describe('文件名（例如 report.md 或 result.json），仅会写入 workspace/tmp'),
                content: z.string().describe('文件内容'),
            }),
        },
    );

    const webSendFile = tool(
        async ({ path: rawPath }: { path: string }) => {
            const context = getWebConversationContext();
            if (!context) {
                return '❌ 当前不是 Web 会话，无法使用 web_send_file。';
            }
            const resolved = resolvePathFromWorkspace(workspaceRoot, rawPath);
            if (!isPathInsideDir(resolved, workspaceTmpRoot)) {
                return `❌ 仅允许回传 workspace/tmp 下文件。当前路径: ${resolved}`;
            }

            let stat;
            try {
                stat = await fsPromises.stat(resolved);
            } catch {
                return `❌ 文件不存在: ${resolved}`;
            }
            if (!stat.isFile()) {
                return `❌ 目标不是文件: ${resolved}`;
            }
            if (stat.size <= 0) {
                return `❌ 文件为空: ${resolved}`;
            }
            if (stat.size > MAX_WEB_REPLY_FILE_BYTES) {
                return `❌ 文件超过 ${Math.floor(MAX_WEB_REPLY_FILE_BYTES / 1024 / 1024)}MB 限制: ${resolved}`;
            }

            queueWebReplyFile(resolved);
            return `✅ 已登记回传文件: ${resolved}`;
        },
        {
            name: 'web_send_file',
            description: '登记回传附件。只接受 workspace/tmp 下且受大小限制的文件（仅 Web 会话可用）。',
            schema: z.object({
                path: z.string().describe('待回传文件路径（建议使用 workspace/tmp/...）'),
            }),
        },
    );

    log?.debug?.('[WebTools] file return tools enabled');
    return [webWriteTmpFile, webSendFile];
}
