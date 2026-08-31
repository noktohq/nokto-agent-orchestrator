import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorktree,
  deleteLocalBranch,
  removeWorktree,
} from '../../src/orchestrator/worktree.js';
import type { OrchestratorConfig } from '../../src/config.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Ekte git worktree-isolasjonstest: bygger et opphavsrepo + en klone i midlertidige
 * mapper (ingen mocking av git), og verifiserer at createWorktree/removeWorktree/
 * deleteLocalBranch faktisk oppretter og rydder opp isolerte arbeidstrær.
 */
describe('worktree-isolasjon (ekte git)', () => {
  let root: string;
  let originDir: string;
  let repoRoot: string;
  let worktreeDir: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'nokto-worktree-'));
    originDir = resolve(root, 'origin');
    repoRoot = resolve(root, 'clone');
    worktreeDir = resolve(root, 'worktrees');

    git(root, 'init', '--initial-branch=main', originDir);
    writeFileSync(resolve(originDir, 'README.md'), '# test\n', 'utf8');
    git(originDir, 'add', '.');
    git(
      originDir,
      '-c',
      'user.email=test@test.local',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    );

    git(root, 'clone', originDir, repoRoot);
    git(
      repoRoot,
      '-c',
      'user.email=test@test.local',
      '-c',
      'user.name=Test',
      'config',
      'user.email',
      'test@test.local'
    );

    config = {
      repoRoot,
      stateDir: resolve(root, 'state'),
      auditDir: resolve(root, 'audit'),
      worktreeDir,
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
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('oppretter en isolert worktree på en ny branch fra baseBranch', async () => {
    const handle = await createWorktree(config, 'task-1', 1, 'agent/', 'main');

    expect(handle.branch).toBe('agent/task-1-1');
    expect(existsSync(handle.path)).toBe(true);
    expect(existsSync(resolve(handle.path, 'README.md'))).toBe(true);

    const branches = git(repoRoot, 'branch', '--list', 'agent/task-1-1');
    expect(branches).toContain('agent/task-1-1');
  });

  it('endringer i worktreet påvirker ikke hovedarbeidskopien', async () => {
    const handle = await createWorktree(config, 'task-2', 1, 'agent/', 'main');
    writeFileSync(resolve(handle.path, 'new-file.txt'), 'fra agenten\n', 'utf8');
    expect(existsSync(resolve(repoRoot, 'new-file.txt'))).toBe(false);
    expect(existsSync(resolve(handle.path, 'new-file.txt'))).toBe(true);
  });

  it('removeWorktree fjerner arbeidskatalogen', async () => {
    const handle = await createWorktree(config, 'task-3', 1, 'agent/', 'main');
    await removeWorktree(config, handle);
    expect(existsSync(handle.path)).toBe(false);
  });

  it('deleteLocalBranch fjerner branchen etter at worktreet er fjernet', async () => {
    const handle = await createWorktree(config, 'task-4', 1, 'agent/', 'main');
    await removeWorktree(config, handle);
    await deleteLocalBranch(config, handle.branch);
    const branches = git(repoRoot, 'branch', '--list', handle.branch);
    expect(branches.trim()).toBe('');
  });

  it('kaster WorktreeError dersom worktree-stien allerede finnes', async () => {
    await createWorktree(config, 'task-5', 1, 'agent/', 'main');
    await expect(createWorktree(config, 'task-5', 1, 'agent/', 'main')).rejects.toThrow();
  });
});
