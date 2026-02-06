import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ExecAuditEventType =
    | 'policy_denied'
    | 'approval_decision'
    | 'approval_required_but_disabled'
    | 'exec_result';

export interface ExecAuditEvent {
    timestamp: string;
    type: ExecAuditEventType;
    callId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>;
}

function getDateString(date = new Date()): string {
    return date.toISOString().slice(0, 10);
}

function getAuditFilePath(date = new Date()): string {
    const dateStr = getDateString(date);
    return join(process.cwd(), 'logs', `exec-audit-${dateStr}.jsonl`);
}

export async function writeExecAuditEvent(event: ExecAuditEvent): Promise<void> {
    const filePath = getAuditFilePath(new Date(event.timestamp));
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
}
