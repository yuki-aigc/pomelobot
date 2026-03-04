import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { HumanMessage as LCHumanMessage } from '@langchain/core/messages';
import type { ChannelAttachment } from './gateway/types.js';
import type { Config } from '../config.js';
import { createChatModel } from '../llm.js';

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TEXT_FILE_CHARS = 6000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TEXT_MIME_HINTS = [
    'text/',
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/x-javascript',
    'application/csv',
];

const TEXT_FILE_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.ts', '.tsx',
    '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.rb', '.php', '.sql', '.sh',
    '.bash', '.zsh', '.ini', '.toml', '.conf', '.log', '.env',
]);

export interface MediaContextLogger {
    warn: (message: string, ...args: unknown[]) => void;
    debug: (message: string, ...args: unknown[]) => void;
}

function normalizeMimeType(mimeType: string | undefined): string {
    const trimmed = mimeType?.trim();
    return trimmed || 'application/octet-stream';
}

function formatBytes(size: number): string {
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function looksLikeTextFile(filePath: string, mimeType: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_FILE_EXTENSIONS.has(ext)) {
        return true;
    }
    return TEXT_MIME_HINTS.some((hint) => mimeType.startsWith(hint));
}

function looksBinary(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 4096);
    if (sampleLength === 0) return false;
    let suspicious = 0;

    for (let i = 0; i < sampleLength; i += 1) {
        const code = buffer[i];
        if (code === 0) {
            return true;
        }
        const isControl = code < 9 || (code > 13 && code < 32);
        if (isControl) {
            suspicious += 1;
        }
    }
    return suspicious / sampleLength > 0.15;
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
    const handle = await fsPromises.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        const readSize = Math.min(stat.size, maxBytes);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
        return {
            buffer: buffer.subarray(0, bytesRead),
            truncated: stat.size > maxBytes,
        };
    } finally {
        await handle.close();
    }
}

function extractTextFromModelContent(content: unknown): string {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === 'string') return item;
                if (!item || typeof item !== 'object') return '';
                const text = (item as { text?: unknown }).text;
                return typeof text === 'string' ? text : '';
            })
            .join('\n')
            .trim();
    }
    return '';
}

async function describeImage(params: {
    config: Config;
    log: MediaContextLogger;
    imagePath: string;
    mimeType: string;
}): Promise<string | null> {
    let imageBuffer: Buffer;
    try {
        imageBuffer = await fsPromises.readFile(params.imagePath);
    } catch (error) {
        params.log.warn(`[MediaContext] Failed to read image file ${params.imagePath}: ${String(error)}`);
        return null;
    }

    if (imageBuffer.length > MAX_IMAGE_BYTES) {
        params.log.warn(
            `[MediaContext] Skip image understanding for large image (${formatBytes(imageBuffer.length)}): ${params.imagePath}`,
        );
        return null;
    }

    try {
        const model = await createChatModel(params.config, { temperature: 0 });
        const result = await model.invoke([
            new LCHumanMessage({
                content: [
                    {
                        type: 'text',
                        text: '你是媒体解析器。请用中文简洁输出：1) 场景与主体 2) 关键文字/OCR 3) 与用户问题可能相关的信息。不要编造。',
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${normalizeMimeType(params.mimeType)};base64,${imageBuffer.toString('base64')}`,
                        },
                    },
                ],
            }),
        ]);
        const text = extractTextFromModelContent(result.content);
        return text || null;
    } catch (error) {
        params.log.warn(`[MediaContext] Image understanding failed: ${String(error)}`);
        return null;
    }
}

function resolveAttachmentKind(attachment: ChannelAttachment): 'image' | 'file' {
    const hinted = typeof attachment.metadata?.mediaType === 'string'
        ? attachment.metadata.mediaType.toLowerCase()
        : '';
    if (hinted === 'image') {
        return 'image';
    }
    if ((attachment.mimeType || '').toLowerCase().startsWith('image/')) {
        return 'image';
    }
    return 'file';
}

async function buildSingleAttachmentContext(params: {
    config: Config;
    attachment: ChannelAttachment;
    log: MediaContextLogger;
}): Promise<string> {
    const attachment = params.attachment;
    const mediaType = resolveAttachmentKind(attachment);
    const filePath = attachment.path || '';
    const fileName = attachment.name || path.basename(filePath || 'attachment');
    const mimeType = normalizeMimeType(attachment.mimeType);

    let statSize = 0;
    if (filePath) {
        try {
            const stat = await fsPromises.stat(filePath);
            statSize = stat.size;
        } catch {
            statSize = 0;
        }
    }

    const baseLines = [
        '[媒体上下文]',
        `类型: ${mediaType}`,
        `文件: ${fileName}`,
        `MIME: ${mimeType}`,
        `大小: ${formatBytes(statSize)}`,
    ];
    if (filePath) {
        baseLines.push(`本地路径: ${filePath}`);
    }

    if (!filePath) {
        baseLines.push('文件解析: 当前附件未提供本地路径，已保留元信息。');
        return baseLines.join('\n');
    }

    if (mediaType === 'image') {
        const description = await describeImage({
            config: params.config,
            log: params.log,
            imagePath: filePath,
            mimeType,
        });
        baseLines.push(description ? `图片理解:\n${description}` : '图片理解: 无法自动解析，请结合路径自行处理。');
        return baseLines.join('\n');
    }

    if (!looksLikeTextFile(filePath, mimeType)) {
        baseLines.push('文件解析: 该文件不是可直接读取的文本格式，已保留元信息。');
        return baseLines.join('\n');
    }

    try {
        const { buffer, truncated } = await readFilePrefix(filePath, MAX_TEXT_FILE_BYTES);
        if (looksBinary(buffer)) {
            baseLines.push('文件解析: 文件包含二进制内容，无法作为纯文本读取。');
            return baseLines.join('\n');
        }
        const raw = buffer.toString('utf-8').replace(/\u0000/g, '').trim();
        const snippet = raw.length > MAX_TEXT_FILE_CHARS ? `${raw.slice(0, MAX_TEXT_FILE_CHARS)}\n...(truncated)` : raw;
        const truncatedFlag = truncated || raw.length > MAX_TEXT_FILE_CHARS;
        const safeSnippet = snippet.replace(/<\/file>/gi, '</ file>');
        baseLines.push(`<file name="${fileName}" mime="${mimeType}" truncated="${truncatedFlag}">\n${safeSnippet}\n</file>`);
        return baseLines.join('\n');
    } catch (error) {
        params.log.warn(`[MediaContext] Failed to parse file ${filePath}: ${String(error)}`);
        baseLines.push('文件解析: 读取失败，已保留元信息。');
        return baseLines.join('\n');
    }
}

export async function buildAttachmentMediaContext(params: {
    config: Config;
    attachments: ChannelAttachment[];
    log: MediaContextLogger;
}): Promise<string | null> {
    const normalized = params.attachments.filter((attachment) => attachment && attachment.path);
    if (normalized.length === 0) {
        return null;
    }

    const blocks: string[] = [];
    for (const attachment of normalized) {
        blocks.push(await buildSingleAttachmentContext({
            config: params.config,
            attachment,
            log: params.log,
        }));
    }

    return blocks.join('\n\n');
}
