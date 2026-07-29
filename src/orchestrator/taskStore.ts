import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { TaskState } from '../types.js';

export class TaskNotFoundError extends Error {}

/**
 * Persistent oppgavestatus på disk — JSON per oppgave, atomisk skriving
 * (tmp-fil + rename) slik at en krasjet kjøring aldri etterlater en
 * korrupt statusfil. Gjør resume mulig: status leses tilbake akkurat
 * slik den var ved siste vellykkede lagring.
 */
export class TaskStore {
  constructor(private readonly stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  }

  private pathFor(taskId: string): string {
    return resolve(this.stateDir, `${taskId}.json`);
  }

  exists(taskId: string): boolean {
    return existsSync(this.pathFor(taskId));
  }

  save(state: TaskState): void {
    const path = this.pathFor(state.contract.id);
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmpPath, path);
  }

  load(taskId: string): TaskState {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) {
      throw new TaskNotFoundError(`Ingen lagret oppgave med id "${taskId}"`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as TaskState;
  }

  list(): TaskState[] {
    if (!existsSync(this.stateDir)) return [];
    return readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json') && !f.includes('.tmp-'))
      .map((f) => JSON.parse(readFileSync(resolve(this.stateDir, f), 'utf8')) as TaskState);
  }
}
