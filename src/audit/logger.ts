import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSensitiveData } from '../security/redaction.js';

export type ExecAuditEventType =
    | 'policy_denied'
    | 'approval_decision'
    | 'approval_required_but_disabled'
    | 'exec_result';

export interface ExecAuditEvent {
    timestamp: string;
    type: ExecAuditEventType;
    callId: string;
    data: Record<string, unknown>;
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
    const redactedEvent = redactSensitiveData(event) as ExecAuditEvent;
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(redactedEvent)}\n`, 'utf-8');
}
