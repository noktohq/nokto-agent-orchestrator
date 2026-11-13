import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorktree,
  deleteLocalBranch,
  removeWorktree,
} from '../../src/orchestrator/worktree.js';
import {
  agentEnv,
  assertGitConfigUnchanged,
  gitConfigDigest,
  GitIntegrityError,
  inspectionGitEnv,
} from '../../src/security/gitIntegrity.js';
import type { OrchestratorConfig } from '../../src/config.js';

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

describe('agentEnv / inspectionGitEnv', () => {
  it('fjerner tokens og GIT_*-variabler, men beholder leverandørnøkler og PATH', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      GITHUB_APP_TOKEN: 'x',
      GEMINI_API_KEY: 'x',
      NPM_TOKEN: 'x',
      SSH_AUTH_SOCK: '/tmp/agent',
      GIT_DIR: '/annet',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/tmp'",
      ANTHROPIC_API_KEY: 'behold',
      OPENAI_API_KEY: 'behold',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'behold',
      OPENAI_API_KEY: 'behold',
    });
  });

  it('inspeksjonsmiljøet slår av replace-objekter og system-/global konfig', () => {
    const env = inspectionGitEnv({ PATH: '/usr/bin', GIT_DIR: '/annet', GIT_EXTERNAL_DIFF: 'x' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});

describe('gitConfigDigest (ekte git)', () => {
  let root: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'nokto-integritet-'));
    const origin = resolve(root, 'origin');
    git(root, 'init', '-q', '--initial-branch=main', origin);
    writeFileSync(resolve(origin, 'a.txt'), 'a\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'init');
    const repoRoot = resolve(root, 'clone');
    git(root, 'clone', '-q', origin, repoRoot);
    config = {
      repoRoot,
      stateDir: resolve(root, 'state'),
      auditDir: resolve(root, 'audit'),
      worktreeDir: resolve(root, 'worktrees'),
    } as unknown as OrchestratorConfig;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('orkestratorens egne git-kall endrer ikke avtrykket', async () => {
    const before = await gitConfigDigest(config);
    const wt = await createWorktree(config, 'avtrykk', 1, 'agent/', 'main');
    await removeWorktree(config, wt);
    await deleteLocalBranch(config, wt.branch);
    expect(await gitConfigDigest(config)).toBe(before);
    await expect(assertGitConfigUnchanged(config, before)).resolves.toBeUndefined();
  });

  it('en endring fra en worktree (delt .git/config) oppdages', async () => {
    const before = await gitConfigDigest(config);
    const wt = await createWorktree(config, 'avtrykk', 1, 'agent/', 'main');
    git(wt.path, 'config', 'core.sshCommand', 'ssh -o ProxyCommand=ondsinnet');

    await expect(assertGitConfigUnchanged(config, before)).rejects.toThrow(GitIntegrityError);
  });
});
