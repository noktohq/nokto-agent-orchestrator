import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInvocationResult } from '../../src/types.js';

const runCommandMock =
  vi.fn<(argv: readonly string[], opts: unknown) => Promise<ProviderInvocationResult>>();
vi.mock('../../src/providers/exec.js', () => ({
  runCommand: (argv: readonly string[], opts: unknown) => runCommandMock(argv, opts),
  tail: (text: string) => text,
}));

const resolveRepoRefMock = vi.fn();
const createPullRequestMock = vi.fn();
const ensureLabelExistsMock = vi.fn();
const addLabelsToIssueMock = vi.fn();
vi.mock('../../src/providers/github.js', () => ({
  resolveRepoRef: (...args: unknown[]) => resolveRepoRefMock(...args),
  createPullRequest: (...args: unknown[]) => createPullRequestMock(...args),
  ensureLabelExists: (...args: unknown[]) => ensureLabelExistsMock(...args),
  addLabelsToIssue: (...args: unknown[]) => addLabelsToIssueMock(...args),
}));

const assertDiffWithinScopeMock = vi.fn();
vi.mock('../../src/security/scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/scope.js')>()),
  assertDiffWithinScope: (...args: unknown[]) => assertDiffWithinScopeMock(...args),
}));

const assertBaseOnRemoteMock = vi.fn();
const assertGitConfigUnchangedMock = vi.fn();
vi.mock('../../src/security/gitIntegrity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/gitIntegrity.js')>()),
  assertBaseOnRemote: (...args: unknown[]) => assertBaseOnRemoteMock(...args),
  assertGitConfigUnchanged: (...args: unknown[]) => assertGitConfigUnchangedMock(...args),
}));

const resolvePushPolicyMock = vi.fn();
vi.mock('../../src/security/pushPolicy.js', () => ({
  resolvePushPolicy: (...args: unknown[]) => resolvePushPolicyMock(...args),
}));

const { ScopeViolationError, ScopeInspectionError } = await import('../../src/security/scope.js');
const { GitIntegrityError } = await import('../../src/security/gitIntegrity.js');
const { assertCommandAllowed } = await import('../../src/security/allowlist.js');
const { createTaskPullRequest, SecretsInDiffError, PushBlockedError } =
  await import('../../src/orchestrator/pr.js');

function contract() {
  return {
    id: 'pr-test',
    title: 'PR test',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['a/**'], disallowedPaths: [] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm run lint'], mustPass: true },
    constraints: {
      maxRetries: 0,
      timeoutMinutes: 10,
      allowedImplementers: ['claude' as const],
      reviewers: ['claude' as const, 'gemini' as const],
      secondaryReviewers: ['codex' as const, 'gemini' as const],
    },
    git: { baseBranch: 'main', branchPrefix: 'agent/' },
    metadata: { labels: ['label-x'] },
  };
}

const plan = { summary: 'plan', steps: [], risks: [], filesExpectedToChange: ['a/x.ts'] };
const review = { reviewer: 'claude' as const, approved: true, findings: [], raw: '' };
const verify = { passed: true, commands: [] };
const worktree = { path: '/repo/.worktrees/pr-test-1', branch: 'agent/pr-test-1' };

function fakeConfig() {
  return { repoRoot: '/repo' } as unknown as Parameters<typeof createTaskPullRequest>[0];
}

const HEAD_SHA = 'c'.repeat(40);

describe('createTaskPullRequest', () => {
  beforeEach(() => {
    assertDiffWithinScopeMock.mockResolvedValue({
      baseSha: 'b'.repeat(40),
      headSha: HEAD_SHA,
      files: ['a/x.ts'],
    });
    resolvePushPolicyMock.mockResolvedValue({
      protectedBranches: ['main', 'master', 'trunk'],
      branchPrefix: 'agent/',
      originHead: 'trunk',
    });
    assertBaseOnRemoteMock.mockResolvedValue('b'.repeat(40));
    assertGitConfigUnchangedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    assertDiffWithinScopeMock.mockReset();
    resolvePushPolicyMock.mockReset();
    assertBaseOnRemoteMock.mockReset();
    assertGitConfigUnchangedMock.mockReset();
    runCommandMock.mockReset();
    resolveRepoRefMock.mockReset();
    createPullRequestMock.mockReset();
    ensureLabelExistsMock.mockReset();
    addLabelsToIssueMock.mockReset();
  });

  it('blokkerer PR-opprettelse dersom diffen inneholder noe som ligner en hemmelighet', async () => {
    runCommandMock.mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      stdout: '+ const TOKEN = "ghp_' + 'a'.repeat(36) + '"',
      stderr: '',
      durationMs: 5,
      timedOut: false,
    });

    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(SecretsInDiffError);

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it('pusher og oppretter PR med rapport når diffen er ren', async () => {
    runCommandMock
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        stdout: '+ helt vanlig kode',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 100,
        timedOut: false,
      });

    resolveRepoRefMock.mockResolvedValue({ owner: 'example-org', repo: 'example-repo' });
    createPullRequestMock.mockResolvedValue({
      number: 42,
      url: 'https://api.github.com/repos/example-org/example-repo/pulls/42',
      htmlUrl: 'https://github.com/example-org/example-repo/pull/42',
    });
    ensureLabelExistsMock.mockResolvedValue(undefined);
    addLabelsToIssueMock.mockResolvedValue(undefined);

    const result = await createTaskPullRequest(
      fakeConfig(),
      contract(),
      plan,
      review,
      null,
      verify,
      worktree
    );

    expect(result.number).toBe(42);
    const scanCall = runCommandMock.mock.calls[0] as [string[], { env?: NodeJS.ProcessEnv }];
    // Hver commit i base..head skannes, med diff-flagg som viser det som faktisk er lagret.
    expect(scanCall[0]).toEqual(
      expect.arrayContaining([
        'log',
        '-p',
        '--text',
        '--no-textconv',
        '--no-ext-diff',
        '--ignore-submodules=none',
        `${'b'.repeat(40)}..${HEAD_SHA}`,
      ])
    );
    expect(scanCall[1].env?.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(assertBaseOnRemoteMock).toHaveBeenCalledWith(
      expect.anything(),
      'pr-test',
      'main',
      'b'.repeat(40)
    );

    const pushCall = runCommandMock.mock.calls[1] as [string[], { pushPolicy?: unknown }];
    // Nøyaktig den sjekkede commiten til en eksplisitt agentgren, uten hooks.
    expect(pushCall[0]).toEqual([
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'push',
      '--no-verify',
      'origin',
      `${HEAD_SHA}:refs/heads/agent/pr-test-1`,
    ]);
    expect(pushCall[1].pushPolicy).toEqual({
      protectedBranches: ['main', 'master', 'trunk'],
      branchPrefix: 'agent/',
    });
    // Pushen må selv slippe gjennom push-vakten med policyen den sendes med.
    expect(() =>
      assertCommandAllowed(pushCall[0], {
        cwd: worktree.path,
        repoRoot: '/repo',
        pushPolicy: { protectedBranches: ['main', 'master', 'trunk'], branchPrefix: 'agent/' },
      })
    ).not.toThrow();

    const prInput = createPullRequestMock.mock.calls[0]?.[2] as {
      head: string;
      base: string;
      body: string;
    };
    expect(prInput.head).toBe('agent/pr-test-1');
    expect(prInput.base).toBe('main');
    expect(prInput.body).toContain('Kodegjennomgang');
    expect(addLabelsToIssueMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      42,
      expect.arrayContaining(['agent-generated', 'label-x'])
    );
  });

  it('kaster PushBlockedError dersom push feiler', async () => {
    runCommandMock
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        stdout: '+ ren diff',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'remote rejected',
        durationMs: 5,
        timedOut: false,
      });

    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(PushBlockedError);
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it('pusher ikke når scope-vakten finner brudd rett før push', async () => {
    assertDiffWithinScopeMock.mockRejectedValueOnce(
      new ScopeViolationError('brudd', [
        { path: 'b/utenfor.ts', rule: 'outside_allowed', reason: 'utenfor tillatt scope' },
      ])
    );

    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(ScopeViolationError);

    expect(runCommandMock).not.toHaveBeenCalled();
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it('pusher ikke når basen ikke finnes i remote-grenen', async () => {
    assertBaseOnRemoteMock.mockRejectedValueOnce(new GitIntegrityError('base ikke i remote'));
    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(GitIntegrityError);
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it('pusher ikke når git-konfigurasjonen er endret siden agenten startet', async () => {
    assertGitConfigUnchangedMock.mockRejectedValueOnce(new GitIntegrityError('konfig endret'));
    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree, {
        gitConfigDigest: 'før',
      })
    ).rejects.toThrow(GitIntegrityError);
    expect(assertGitConfigUnchangedMock).toHaveBeenCalledWith(expect.anything(), 'før');
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('pusher ikke når patchene ikke kan leses fullstendig (fail closed)', async () => {
    runCommandMock.mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      stdout: 'commit x\n+ kode',
      stderr: '',
      durationMs: 5,
      timedOut: false,
      stdoutTruncated: true,
    });
    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(ScopeInspectionError);
    expect(runCommandMock).toHaveBeenCalledTimes(1);

    runCommandMock.mockReset();
    runCommandMock.mockResolvedValueOnce({
      ok: false,
      exitCode: 128,
      stdout: '',
      stderr: 'fatal',
      durationMs: 5,
      timedOut: false,
    });
    await expect(
      createTaskPullRequest(fakeConfig(), contract(), plan, review, null, verify, worktree)
    ).rejects.toThrow(ScopeInspectionError);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });
});
