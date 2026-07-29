import { afterEach, describe, expect, it, vi } from 'vitest';
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
    constraints: { maxRetries: 0, timeoutMinutes: 10, allowedImplementers: ['claude' as const] },
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

describe('createTaskPullRequest', () => {
  afterEach(() => {
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
    const pushCall = runCommandMock.mock.calls[1] as [string[], unknown];
    expect(pushCall[0]).toEqual(['git', 'push', '-u', 'origin', 'agent/pr-test-1']);

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
});
