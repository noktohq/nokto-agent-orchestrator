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
vi.mock('../../src/security/scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/scope.js')>()),
  assertDiffWithinScope: vi.fn(),
}));
vi.mock('../../src/security/gitIntegrity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/gitIntegrity.js')>()),
  gitConfigDigest: vi.fn(),
  assertGitConfigUnchanged: vi.fn(),
}));

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
const { assertDiffWithinScope, ScopeViolationError, ScopeInspectionError } =
  await import('../../src/security/scope.js');
const { gitConfigDigest, assertGitConfigUnchanged, GitIntegrityError } =
  await import('../../src/security/gitIntegrity.js');
const { AuditLog } = await import('../../src/audit.js');
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
      return {
        path: resolve(dir, `wt-${attemptCounter}`),
        branch: `agent/x-${attemptCounter}`,
        baseSha: `${attemptCounter}`.repeat(40),
      };
    });
    vi.mocked(gitConfigDigest).mockResolvedValue('digest-1');
    vi.mocked(assertGitConfigUnchanged).mockResolvedValue(undefined);
    vi.mocked(removeWorktree).mockResolvedValue(undefined);
    vi.mocked(deleteLocalBranch).mockResolvedValue(undefined);
    vi.mocked(needsSecondaryReview).mockReturnValue(false);
    vi.mocked(reviewCode).mockResolvedValue(okReview);
    vi.mocked(runVerify).mockResolvedValue(okVerify);
    vi.mocked(assertDiffWithinScope).mockResolvedValue({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      files: ['a/x.ts'],
    });
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

  describe('scope-vakt', () => {
    const okImpl = { ok: true, implementer: 'claude' as const, summary: 'ferdig', stderrTail: '' };
    const violation = new ScopeViolationError('Diffen bryter oppgavens scope (1 brudd)', [
      { path: '.github/workflows/ci.yml', rule: 'hard_blocked', reason: 'alltid blokkert' },
    ]);

    it('sjekker diffen etter implementering, før gjennomgang', async () => {
      vi.mocked(implementTask).mockResolvedValue(okImpl);
      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract());

      expect(state.phase).toBe('pr_created');
      expect(assertDiffWithinScope).toHaveBeenCalledTimes(1);
      const scopeOrder = vi.mocked(assertDiffWithinScope).mock.invocationCallOrder[0] ?? 0;
      const reviewOrder = vi.mocked(reviewCode).mock.invocationCallOrder[0] ?? 0;
      expect(scopeOrder).toBeLessThan(reviewOrder);
      const events = new AuditLog(config.auditDir, 'pipeline-test').readAll();
      expect(events.some((e) => e.type === 'scope_check_passed')).toBe(true);
    });

    it('brudd etter implementering: oppgaven feiler, ingen gjennomgang, ingen nye forsøk, ingen PR', async () => {
      vi.mocked(implementTask).mockResolvedValue(okImpl);
      vi.mocked(assertDiffWithinScope).mockRejectedValueOnce(violation);
      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract({ maxRetries: 3 }));

      expect(state.phase).toBe('failed');
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0]?.failureReason).toContain('Scope-vakt');
      expect(reviewCode).not.toHaveBeenCalled();
      expect(runVerify).not.toHaveBeenCalled();
      expect(createTaskPullRequest).not.toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(deleteLocalBranch).toHaveBeenCalledTimes(1);

      const events = new AuditLog(config.auditDir, 'pipeline-test').readAll();
      const v = events.find((e) => e.type === 'scope_violation');
      expect(v?.stage).toBe('after_implementation');
      expect(v?.violations).toEqual([{ path: '.github/workflows/ci.yml', rule: 'hard_blocked' }]);
    });

    it('sjekker hvert forsøk: brudd etter en korrigering stopper oppgaven', async () => {
      vi.mocked(implementTask).mockResolvedValue(okImpl);
      vi.mocked(reviewCode).mockResolvedValueOnce({
        reviewer: 'claude',
        approved: false,
        findings: [{ severity: 'blocker', file: 'a/x.ts', summary: 'feil' }],
        raw: '',
      });
      vi.mocked(assertDiffWithinScope)
        .mockResolvedValueOnce({
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          files: ['a/x.ts'],
        })
        .mockRejectedValueOnce(violation);

      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract({ maxRetries: 3 }));

      expect(assertDiffWithinScope).toHaveBeenCalledTimes(2);
      expect(state.attempts).toHaveLength(2);
      expect(state.phase).toBe('failed');
      expect(createTaskPullRequest).not.toHaveBeenCalled();
    });

    it('feil under git-inspeksjon behandles som brudd (fail closed)', async () => {
      vi.mocked(implementTask).mockResolvedValue(okImpl);
      vi.mocked(assertDiffWithinScope).mockRejectedValueOnce(
        new ScopeInspectionError('git diff feilet')
      );
      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract());

      expect(state.phase).toBe('failed');
      expect(reviewCode).not.toHaveBeenCalled();
      expect(createTaskPullRequest).not.toHaveBeenCalled();
    });

    it('brudd oppdaget rett før push: oppgaven feiler i stedet for "completed"', async () => {
      vi.mocked(implementTask).mockResolvedValue(okImpl);
      vi.mocked(createTaskPullRequest).mockRejectedValueOnce(violation);
      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract());

      expect(state.phase).toBe('failed');
      expect(state.prUrl).toBeNull();
      const events = new AuditLog(config.auditDir, 'pipeline-test').readAll();
      expect(events.find((e) => e.type === 'scope_violation')?.stage).toBe('before_push');
      expect(events.some((e) => e.type === 'pr_creation_skipped')).toBe(false);
    });
  });

  describe('låst base og git-integritet mellom forsøk', () => {
    it('forsøk 2 bruker base-commiten fra forsøk 1, ikke en ny fetch', async () => {
      vi.mocked(implementTask)
        .mockResolvedValueOnce({ ok: false, implementer: 'claude', summary: '', stderrTail: 'x' })
        .mockResolvedValueOnce({ ok: true, implementer: 'claude', summary: 'ok', stderrTail: '' });

      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract({ maxRetries: 1 }));

      expect(state.phase).toBe('pr_created');
      const calls = vi.mocked(createWorktree).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[5]).toEqual({});
      expect(calls[1]?.[5]).toEqual({ baseSha: '1'.repeat(40) });
      expect(state.security).toEqual({ baseSha: '1'.repeat(40), gitConfigDigest: 'digest-1' });
      expect(vi.mocked(reviewCode).mock.calls[0]?.[4]).toBe('2'.repeat(40));
      expect(vi.mocked(createTaskPullRequest).mock.calls[0]?.[7]).toEqual({
        gitConfigDigest: 'digest-1',
      });
    });

    it('stopper når git-konfigurasjonen er endret før et nytt forsøk', async () => {
      vi.mocked(implementTask).mockResolvedValue({
        ok: false,
        implementer: 'claude',
        summary: '',
        stderrTail: 'feilet med vilje',
      });
      vi.mocked(assertGitConfigUnchanged)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new GitIntegrityError('konfig endret'));

      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract({ maxRetries: 2 }));

      expect(state.phase).toBe('failed');
      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(state.attempts.at(-1)?.failureReason).toMatch(/Git-integritet/);
      expect(createTaskPullRequest).not.toHaveBeenCalled();
    });

    it('git-integritetsfeil rett før push gir failed, ikke completed', async () => {
      vi.mocked(implementTask).mockResolvedValue({
        ok: true,
        implementer: 'claude',
        summary: 'ok',
        stderrTail: '',
      });
      vi.mocked(createTaskPullRequest).mockRejectedValueOnce(
        new GitIntegrityError('base finnes ikke i remote')
      );

      const store = new TaskStore(config.stateDir);
      const state = await runTask({ config, store }, contract({ maxRetries: 0 }));

      expect(state.phase).toBe('failed');
      expect(state.attempts.at(-1)?.failureReason).toMatch(/base finnes ikke/);
    });
  });
});
