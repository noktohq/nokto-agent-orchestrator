import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskNotFoundError, TaskStore } from '../../src/orchestrator/taskStore.js';
import type { TaskState } from '../../src/types.js';

function fakeState(id: string, phase: TaskState['phase'] = 'created'): TaskState {
  return {
    contract: {
      id,
      title: 'Test',
      goal: 'Test',
      scope: { description: 'x', allowedPaths: ['a/**'], disallowedPaths: [] },
      acceptanceCriteria: ['x'],
      testRequirements: { commands: ['pnpm run lint'], mustPass: true },
      constraints: {
        maxRetries: 2,
        timeoutMinutes: 30,
        allowedImplementers: ['codex', 'claude'],
        reviewers: ['claude', 'gemini'],
        secondaryReviewers: ['codex', 'gemini'],
      },
      git: { baseBranch: 'main', branchPrefix: 'agent/' },
      metadata: { labels: [] },
    },
    phase,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    attempts: [],
    prUrl: null,
    cancelled: false,
    dryRun: false,
  };
}

describe('TaskStore', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'nokto-taskstore-'));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exists() er false før noe er lagret', () => {
    expect(store.exists('foo')).toBe(false);
  });

  it('lagrer og laster tilbake identisk status', () => {
    const state = fakeState('foo', 'planning');
    store.save(state);
    expect(store.exists('foo')).toBe(true);
    expect(store.load('foo')).toEqual(state);
  });

  it('overskriver ved ny lagring uten å etterlate en korrupt fil (atomisk skriving)', () => {
    store.save(fakeState('foo', 'created'));
    store.save(fakeState('foo', 'completed'));
    expect(store.load('foo').phase).toBe('completed');
  });

  it('kaster TaskNotFoundError for ukjent id', () => {
    expect(() => store.load('mangler')).toThrow(TaskNotFoundError);
  });

  it('list() returnerer alle lagrede oppgaver', () => {
    store.save(fakeState('a'));
    store.save(fakeState('b'));
    const all = store.list();
    expect(all.map((s) => s.contract.id).sort()).toEqual(['a', 'b']);
  });

  it('list() returnerer tom liste når ingenting er lagret', () => {
    expect(store.list()).toEqual([]);
  });
});
