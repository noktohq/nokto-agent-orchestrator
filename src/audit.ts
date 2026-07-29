import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from './security/secretScan.js';

export interface AuditEvent {
  ts: string;
  taskId: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Strukturert JSONL-auditlogg — én linje per hendelse, aldri overskrevet.
 * Alle strengfelt kjøres gjennom redact() før skriving, som andre
 * forsvarslinje mot at en hemmelighet havner i loggen.
 */
export class AuditLog {
  private readonly filePath: string;

  constructor(auditDir: string, taskId: string) {
    if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });
    this.filePath = resolve(auditDir, `${taskId}.jsonl`);
  }

  record(type: string, taskId: string, data: Record<string, unknown> = {}): AuditEvent {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      taskId,
      type,
      ...redactDeep(data),
    };
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  readAll(): AuditEvent[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  get path(): string {
    return this.filePath;
  }
}

function redactDeep(value: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as Record<string, unknown>;
}
