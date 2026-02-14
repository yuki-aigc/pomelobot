const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|password|secret)/i;

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
    {
        pattern: /(authorization\s*:\s*bearer\s+)([^\s"']+)/gi,
        replace: '$1[REDACTED]',
    },
    {
        pattern: /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*([\S]+)/gi,
        replace: '$1=[REDACTED]',
    },
    {
        pattern: /(\"(?:api[_-]?key|token|password|secret)\"\s*:\s*\")(.*?)(\")/gi,
        replace: '$1[REDACTED]$3',
    },
    {
        pattern: /\b(sk-[A-Za-z0-9._\-]{12,})\b/g,
        replace: '[REDACTED]',
    },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === '[object Object]';
}

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactSensitiveText(input: string): string {
    let redacted = input;
    for (const { pattern, replace } of REDACTION_PATTERNS) {
        redacted = redacted.replace(pattern, replace);
    }
    return redacted;
}

export function redactSensitiveData(value: unknown): unknown {
    if (typeof value === 'string') {
        return redactSensitiveText(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactSensitiveData(item));
    }

    if (!value || !isPlainObject(value)) {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
            result[key] = '[REDACTED]';
            continue;
        }
        result[key] = redactSensitiveData(nestedValue);
    }
    return result;
}
