import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConfig } from '../../src/config.js';
import type { TaskContract } from '../../src/types.js';

vi.mock('../../src/orchestrator/planner.js', () => ({ planTask: vi.fn() }));
vi.mock('../../src/orchestrator/validator.js', () => ({ validatePlan: vi.fn() }));
vi.mock('../../src/orchestrator/worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  deleteLocalBranch: vi.fn(),
}));
vi.mock('../../src/orchestrator/implementer.js', () => ({ implementTask: vi.fn() }));
vi.mock('../../src/orchestrator/reviewer.js', () => ({
  reviewCode: vi.fn(),
  reviewHasBlockers: (r: { findings: Array<{ severity: string }> }) =>
    r.findings.some((f) => f.severity === 'blocker'),
}));
vi.mock('../../src/orchestrator/secondaryReviewer.js', () => ({
  needsSecondaryReview: vi.fn(),
  secondaryReviewCode: vi.fn(),
}));
vi.mock('../../src/orchestrator/verifier.js', () => ({ runVerify: vi.fn() }));
vi.mock('../../src/orchestrator/pr.js', () => ({ createTaskPullRequest: vi.fn() }));

const { planTask } = await import('../../src/orchestrator/planner.js');
const { validatePlan } = await import('../../src/orchestrator/validator.js');
const { createWorktree, removeWorktree, deleteLocalBranch } =
  await import('../../src/orchestrator/worktree.js');
const { implementTask } = await import('../../src/orchestrator/implementer.js');
const { reviewCode } = await import('../../src/orchestrator/reviewer.js');
const { needsSecondaryReview, secondaryReviewCode } =
  await import('../../src/orchestrator/secondaryReviewer.js');
const { runVerify } = await import('../../src/orchestrator/verifier.js');
const { createTaskPullRequest } = await import('../../src/orchestrator/pr.js');
const { runTask } = await import('../../src/orchestrator/pipeline.js');
const { TaskStore } = await import('../../src/orchestrator/taskStore.js');

function contract(overrides: Partial<TaskContract['constraints']> = {}): TaskContract {
  return {
    id: 'pipeline-test',
    title: 'Pipeline test',
    goal: 'Test hele arbeidsflyten',
    scope: { description: 'x', allowedPaths: ['a/**'], disallowedPaths: [] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm run lint'], mustPass: true },
    constraints: {
      maxRetries: 1,
      timeoutMinutes: 10,
      allowedImplementers: ['claude'],
      reviewers: ['claude', 'gemini'],
      secondaryReviewers: ['codex', 'gemini'],
      ...overrides,
    },
    git: { baseBranch: 'main', branchPrefix: 'agent/' },
    metadata: { labels: [] },
  };
}

const plan = { summary: 'plan', steps: [], risks: [], filesExpectedToChange: ['a/x.ts'] };
const okReview = { reviewer: 'claude' as const, approved: true, findings: [], raw: '' };
const okVerify = { passed: true, commands: [] };

describe('runTask (pipeline, med mockede agent-leverandører)', () => {
  let dir: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'nokto-pipeline-'));
    config = {
      repoRoot: dir,
      stateDir: resolve(dir, 'state'),
      auditDir: resolve(dir, 'audit'),
      worktreeDir: resolve(dir, 'worktrees'),
      claudeBin: 'claude',
      claudeModel: undefined,
      claudeMaxBudgetUsd: undefined,
      claudeTimeoutSec: 900,
      codexBin: 'codex',
      codexModel: undefined,
      codexSandbox: 'workspace-write',
      codexTimeoutSec: 1800,
      geminiApiKey: undefined,
      geminiModel: 'gemini-3.5-flash',
      geminiTimeoutSec: 600,
      githubToken: undefined,
      githubApiBase: 'https://api.github.com',
      githubOwner: undefined,
      githubRepo: undefined,
    };

    vi.mocked(planTask).mockResolvedValue(plan);
    vi.mocked(validatePlan).mockResolvedValue({ approved: true, reasons: [] });
    let attemptCounter = 0;
    vi.mocked(createWorktree).mockImplementation(async () => {
      attemptCounter += 1;
      return { path: resolve(dir, `wt-${attemptCounter}`), branch: `agent/x-${attemptCounter}` };
    });
    vi.mocked(removeWorktree).mockResolvedValue(undefined);
    vi.mocked(deleteLocalBranch).mockResolvedValue(undefined);
    vi.mocked(needsSecondaryReview).mockReturnValue(false);
    vi.mocked(reviewCode).mockResolvedValue(okReview);
    vi.mocked(runVerify).mockResolvedValue(okVerify);
    vi.mocked(createTaskPullRequest).mockResolvedValue({
      number: 1,
      url: 'https://api.github.com/repos/x/y/pulls/1',
      htmlUrl: 'https://github.com/x/y/pull/1',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('dry-run stopper før implementering — ingen PR, implementTask kalles aldri', async () => {
    const store = new TaskStore(config.stateDir);
    const c = contract();
    const state = await runTask({ config, store }, c, { dryRun: true });

    expect(state.phase).toBe('completed');
    expect(implementTask).not.toHaveBeenCalled();
    expect(createTaskPullRequest).not.toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it('lykkes ved første forsøk og oppretter PR', async () => {
    vi.mocked(implementTask).mockResolvedValue({
      ok: true,
      implementer: 'claude',
      summary: 'ferdig',
      stderrTail: '',
    });
    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract());

    expect(state.phase).toBe('pr_created');
    expect(state.prUrl).toBe('https://github.com/x/y/pull/1');
    expect(state.attempts).toHaveLength(1);
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it('prøver på nytt etter en feilet implementering og lykkes på forsøk 2', async () => {
    vi.mocked(implementTask)
      .mockResolvedValueOnce({ ok: false, implementer: 'claude', summary: '', stderrTail: 'boom' })
      .mockResolvedValueOnce({
        ok: true,
        implementer: 'claude',
        summary: 'ferdig',
        stderrTail: '',
      });

    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract({ maxRetries: 1 }));

    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0]?.failureReason).toContain('boom');
    expect(state.phase).toBe('pr_created');
    expect(createWorktree).toHaveBeenCalledTimes(2);
  });

  it('feiler permanent når alle forsøk er brukt opp', async () => {
    vi.mocked(implementTask).mockResolvedValue({
      ok: false,
      implementer: 'claude',
      summary: '',
      stderrTail: 'alltid feil',
    });

    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract({ maxRetries: 0 }));

    expect(state.phase).toBe('failed');
    expect(state.attempts).toHaveLength(1);
    expect(createTaskPullRequest).not.toHaveBeenCalled();
  });

  it('avviser planen når validering feiler — ingen forsøk kjøres', async () => {
    vi.mocked(validatePlan).mockResolvedValue({ approved: false, reasons: ['bryter scope'] });
    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract());

    expect(state.phase).toBe('failed');
    expect(state.attempts).toHaveLength(0);
    expect(implementTask).not.toHaveBeenCalled();
  });

  it('avbryter kjøringen når en annen prosess kansellerer mellom forsøk', async () => {
    vi.mocked(implementTask).mockResolvedValue({
      ok: false,
      implementer: 'claude',
      summary: '',
      stderrTail: 'boom',
    });

    const store = new TaskStore(config.stateDir);
    const c = contract({ maxRetries: 3 });

    vi.mocked(removeWorktree).mockImplementationOnce(async () => {
      const state = store.load(c.id);
      state.cancelled = true;
      store.save(state);
    });

    const state = await runTask({ config, store }, c);

    expect(state.phase).toBe('cancelled');
    expect(state.attempts).toHaveLength(1);
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it('kjører sekundær kontroll når needsSecondaryReview er true, og respekterer avvisning', async () => {
    vi.mocked(implementTask).mockResolvedValue({
      ok: true,
      implementer: 'claude',
      summary: 'ferdig',
      stderrTail: '',
    });
    vi.mocked(needsSecondaryReview).mockReturnValue(true);
    vi.mocked(secondaryReviewCode).mockResolvedValue({
      reviewer: 'codex',
      approved: false,
      findings: [{ severity: 'blocker', file: 'a.ts', summary: 'feil' }],
      raw: '',
    });

    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract({ maxRetries: 0 }));

    expect(secondaryReviewCode).toHaveBeenCalled();
    expect(state.phase).toBe('failed');
    expect(state.attempts[0]?.failureReason).toContain('Sekundær kontroll avvist');
  });
});
