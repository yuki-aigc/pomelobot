export interface ParsedCommand {
    tokens: string[];
    command: string;
    args: string[];
}

export interface ParseCommandResult {
    ok: boolean;
    parsed?: ParsedCommand;
    error?: string;
}

/**
 * Tokenize a command string with shell-like quotes/escape handling.
 * We still execute with shell=false, so this is only for robust parsing.
 */
export function parseCommandInput(input: string): ParseCommandResult {
    const command = input.trim();
    if (!command) {
        return { ok: false, error: 'Empty command' };
    }

    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];

        if (escaping) {
            current += ch;
            escaping = false;
            continue;
        }

        if (quote === "'") {
            if (ch === "'") {
                quote = null;
            } else {
                current += ch;
            }
            continue;
        }

        if (quote === '"') {
            if (ch === '"') {
                quote = null;
                continue;
            }
            if (ch === '\\') {
                const next = command[i + 1];
                if (!next) {
                    return { ok: false, error: 'Invalid trailing escape in double-quoted string' };
                }
                current += next;
                i += 1;
                continue;
            }
            current += ch;
            continue;
        }

        if (ch === '\\') {
            escaping = true;
            continue;
        }

        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }

        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (escaping) {
        return { ok: false, error: 'Invalid trailing escape character' };
    }
    if (quote) {
        return { ok: false, error: `Unclosed ${quote === '"' ? 'double' : 'single'} quote` };
    }
    if (current) {
        tokens.push(current);
    }
    if (tokens.length === 0) {
        return { ok: false, error: 'Empty command' };
    }

    return {
        ok: true,
        parsed: {
            tokens,
            command: tokens[0]!,
            args: tokens.slice(1),
        },
    };
}
