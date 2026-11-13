import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOriginHead, resolvePushPolicy } from '../../src/security/pushPolicy.js';
import { assertCommandAllowed, CommandNotAllowedError } from '../../src/security/allowlist.js';
import type { OrchestratorConfig } from '../../src/config.js';
import type { TaskContract } from '../../src/types.js';

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

function contract(baseBranch = 'develop'): TaskContract {
  return {
    id: 'push-policy',
    title: 'x',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['**'], disallowedPaths: [] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm run lint'], mustPass: true },
    constraints: {
      maxRetries: 0,
      timeoutMinutes: 10,
      allowedImplementers: ['claude'],
      reviewers: ['claude', 'gemini'],
      secondaryReviewers: ['codex', 'gemini'],
    },
    git: { baseBranch, branchPrefix: 'agent/' },
    metadata: { labels: [] },
  };
}

/** Push-policy mot ekte git: standardgrenen leses fra refs/remotes/origin/HEAD. */
describe('resolvePushPolicy (ekte git)', () => {
  let root: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'nokto-pushpolicy-'));
    const originDir = resolve(root, 'origin');
    const repoRoot = resolve(root, 'clone');
    git(root, 'init', '-q', '--initial-branch=trunk', originDir);
    writeFileSync(resolve(originDir, 'README.md'), '# test\n', 'utf8');
    git(originDir, 'add', '.');
    git(originDir, 'commit', '-q', '-m', 'init');
    git(root, 'clone', '-q', originDir, repoRoot);
    config = { repoRoot } as unknown as OrchestratorConfig;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('beskytter main, master, baseBranch og repoets faktiske standardgren', async () => {
    const policy = await resolvePushPolicy(config, contract('develop'));
    expect(policy.originHead).toBe('trunk');
    expect(policy.protectedBranches).toEqual(['main', 'master', 'develop', 'trunk']);
    expect(policy.branchPrefix).toBe('agent/');

    const ctx = { cwd: resolve(root, 'wt'), repoRoot: config.repoRoot, pushPolicy: policy };
    for (const target of ['trunk', 'HEAD:refs/heads/trunk', 'develop', 'main', 'master']) {
      expect(() => assertCommandAllowed(['git', 'push', 'origin', target], ctx), target).toThrow(
        CommandNotAllowedError
      );
    }
    expect(() =>
      assertCommandAllowed(['git', 'push', 'origin', 'HEAD:refs/heads/agent/x-1'], ctx)
    ).not.toThrow();
  });

  it('uten origin/HEAD: main, master og baseBranch er fortsatt beskyttet, og prefikset gjelder', async () => {
    git(config.repoRoot, 'remote', 'set-head', 'origin', '-d');
    expect(await resolveOriginHead(config)).toBeNull();

    const policy = await resolvePushPolicy(config, contract('main'));
    expect(policy.originHead).toBeNull();
    expect(policy.protectedBranches).toEqual(['main', 'master']);

    // trunk er standardgrenen, men kan ikke leses — prefikskravet stopper pushen likevel.
    const ctx = { cwd: resolve(root, 'wt'), repoRoot: config.repoRoot, pushPolicy: policy };
    expect(() => assertCommandAllowed(['git', 'push', 'origin', 'trunk'], ctx)).toThrow(
      /grenprefiks/
    );
  });
});
