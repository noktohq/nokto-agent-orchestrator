import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConfig } from '../../src/config.js';
import type { TaskContract } from '../../src/types.js';

/**
 * createTaskPullRequest ende til ende mot en lokal bare-remote. Bare GitHub-API-et er
 * mocket; scope-vakten, git-integritetssjekkene, hemmelighetsskanningen, push-vakten og
 * selve pushen kjører med ekte git.
 */
const createPullRequestMock = vi.fn();
vi.mock('../../src/providers/github.js', () => ({
  resolveRepoRef: async () => ({ owner: 'example-org', repo: 'example-repo' }),
  createPullRequest: (...args: unknown[]) => createPullRequestMock(...args),
  ensureLabelExists: async () => undefined,
  addLabelsToIssue: async () => undefined,
}));

const { createWorktree } = await import('../../src/orchestrator/worktree.js');
const { createTaskPullRequest, SecretsInDiffError } = await import('../../src/orchestrator/pr.js');
const { assertDiffWithinScope, ScopeViolationError } = await import('../../src/security/scope.js');
const { gitConfigDigest, GitIntegrityError } = await import('../../src/security/gitIntegrity.js');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function write(root: string, rel: string, content = 'x\n'): void {
  const full = resolve(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commitAll(cwd: string, msg = 'endring'): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
}

function contract(): TaskContract {
  return {
    id: 'pr-int',
    title: 'PR integrasjon',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['src/**'], disallowedPaths: [] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm run lint'], mustPass: true },
    constraints: {
      maxRetries: 0,
      timeoutMinutes: 10,
      allowedImplementers: ['claude'],
      reviewers: ['claude', 'gemini'],
      secondaryReviewers: ['codex', 'gemini'],
    },
    git: { baseBranch: 'main', branchPrefix: 'agent/' },
    metadata: { labels: [] },
  };
}

const plan = { summary: 'plan', steps: [], risks: [], filesExpectedToChange: ['src/a.ts'] };
const review = { reviewer: 'claude' as const, approved: true, findings: [], raw: '' };
const verify = { passed: true, commands: [] };

describe('createTaskPullRequest mot lokal bare-remote (ekte git, uten mock av scope/exec)', () => {
  let root: string;
  let remote: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'nokto-pr-int-'));
    remote = resolve(root, 'remote.git');
    const seed = resolve(root, 'seed');
    git(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
    git(root, 'init', '-q', '--initial-branch=main', seed);
    write(seed, 'src/a.ts', 'export const a = 1;\n');
    write(seed, 'README.md', '# x\n');
    commitAll(seed, 'første');
    git(seed, 'push', '-q', remote, 'main:main');
    const repoRoot = resolve(root, 'clone');
    git(root, 'clone', '-q', remote, repoRoot);
    config = {
      repoRoot,
      stateDir: resolve(root, 'state'),
      auditDir: resolve(root, 'audit'),
      worktreeDir: resolve(root, 'worktrees'),
    } as unknown as OrchestratorConfig;
    createPullRequestMock.mockReset();
    createPullRequestMock.mockResolvedValue({
      number: 7,
      url: 'https://api.github.com/repos/example-org/example-repo/pulls/7',
      htmlUrl: 'https://github.com/example-org/example-repo/pull/7',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function remoteRef(ref: string): string {
    return git(remote, 'for-each-ref', '--format=%(objectname)', ref).trim();
  }

  it('pusher nøyaktig den sjekkede commiten og oppretter PR', async () => {
    const wt = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    const digest = await gitConfigDigest(config);
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    const head = git(wt.path, 'rev-parse', 'HEAD').trim();

    const pr = await createTaskPullRequest(config, contract(), plan, review, null, verify, wt, {
      gitConfigDigest: digest,
    });

    expect(pr.number).toBe(7);
    expect(remoteRef(`refs/heads/${wt.branch}`)).toBe(head);
    expect(remoteRef('refs/heads/main')).not.toBe(head);
  });

  it('en endring etter første sjekk (f.eks. under verify) stoppes før push', async () => {
    const wt = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    await assertDiffWithinScope(config, contract(), wt); // passerer
    write(wt.path, '.github/workflows/evil.yml', 'name: evil\n');
    commitAll(wt.path, 'ond');

    await expect(
      createTaskPullRequest(config, contract(), plan, review, null, verify, wt)
    ).rejects.toThrow(ScopeViolationError);
    expect(remoteRef(`refs/heads/${wt.branch}`)).toBe('');
    expect(createPullRequestMock).not.toHaveBeenCalled();
  });

  it('en hemmelighet i en mellomliggende commit stopper pushen', async () => {
    const wt = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    write(wt.path, 'src/key.ts', `export const k = "ghp_${'a'.repeat(36)}";\n`);
    commitAll(wt.path, 'nøkkel');
    git(wt.path, 'rm', '-q', 'src/key.ts');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path, 'fjern nøkkel');

    await expect(
      createTaskPullRequest(config, contract(), plan, review, null, verify, wt)
    ).rejects.toThrow(SecretsInDiffError);
    expect(remoteRef(`refs/heads/${wt.branch}`)).toBe('');
  });

  it('`* -diff` i .git/info/attributes skjuler ikke en hemmelighet for skanningen', async () => {
    const wt = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    const common = git(wt.path, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    write(common, 'info/attributes', '* -diff\n');
    write(wt.path, 'src/key.ts', `export const k = "ghp_${'b'.repeat(36)}";\n`);
    commitAll(wt.path);
    // Uten --text viser git bare «Binary files … differ».
    expect(git(wt.path, 'diff', `${wt.baseSha as string}`, 'HEAD')).toMatch(/Binary files/);

    await expect(
      createTaskPullRequest(config, contract(), plan, review, null, verify, wt)
    ).rejects.toThrow(SecretsInDiffError);
    expect(remoteRef(`refs/heads/${wt.branch}`)).toBe('');
  });

  it('endret git-konfig (remote.origin.pushurl) stopper pushen', async () => {
    const evilRemote = resolve(root, 'evil.git');
    git(root, 'init', '-q', '--bare', evilRemote);
    const wt = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    const digest = await gitConfigDigest(config);
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    git(wt.path, 'config', 'remote.origin.pushurl', evilRemote);

    await expect(
      createTaskPullRequest(config, contract(), plan, review, null, verify, wt, {
        gitConfigDigest: digest,
      })
    ).rejects.toThrow(GitIntegrityError);
    expect(git(evilRemote, 'for-each-ref').trim()).toBe('');
    expect(remoteRef(`refs/heads/${wt.branch}`)).toBe('');
  });

  it('en base som ikke finnes i remote-grenen stopper pushen (forgiftet base)', async () => {
    const wt1 = await createWorktree(config, 'pr-int', 1, 'agent/', 'main');
    write(wt1.path, '.github/workflows/evil.yml', 'name: evil\n');
    commitAll(wt1.path, 'ond');
    const evil = git(wt1.path, 'rev-parse', 'HEAD').trim();

    // Forsøk 2 bygget på den onde commiten (slik en forgiftet origin/main ville gitt).
    const wt2 = await createWorktree(config, 'pr-int', 2, 'agent/', 'main', { baseSha: evil });
    write(wt2.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt2.path);

    await expect(
      createTaskPullRequest(config, contract(), plan, review, null, verify, wt2)
    ).rejects.toThrow(GitIntegrityError);
    expect(remoteRef(`refs/heads/${wt2.branch}`)).toBe('');
    expect(() => git(remote, 'cat-file', '-e', `${evil}^{commit}`)).toThrow();
  });
});
