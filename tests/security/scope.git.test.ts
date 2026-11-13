import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, type WorktreeHandle } from '../../src/orchestrator/worktree.js';
import {
  assertDiffWithinScope,
  ScopeInspectionError,
  ScopeViolationError,
  type ScopeRule,
} from '../../src/security/scope.js';
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

function write(root: string, rel: string, content = 'x\n'): void {
  const full = resolve(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function commitAll(cwd: string, msg = 'endring'): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
}

function contract(
  allowedPaths: string[] = ['src/**', 'docs/**'],
  disallowedPaths: string[] = ['src/secret/**']
): TaskContract {
  return {
    id: 'scope-test',
    title: 'Scope test',
    goal: 'x',
    scope: { description: 'x', allowedPaths, disallowedPaths },
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

async function violationsOf(
  config: OrchestratorConfig,
  c: TaskContract,
  wt: WorktreeHandle
): Promise<Array<{ path: string; rule: ScopeRule }>> {
  try {
    await assertDiffWithinScope(config, c, wt);
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      return err.violations.map((v) => ({ path: v.path, rule: v.rule }));
    }
    throw err;
  }
  throw new Error('Forventet ScopeViolationError, men sjekken passerte.');
}

/**
 * Scope-vakten mot ekte git: opphavsrepo + klone + worktree i midlertidige mapper,
 * ingen mocking av git.
 */
describe('assertDiffWithinScope (ekte git)', () => {
  let root: string;
  let outside: string;
  let config: OrchestratorConfig;
  let wt: WorktreeHandle;

  beforeEach(async () => {
    root = mkdtempSync(resolve(tmpdir(), 'nokto-scope-'));
    outside = resolve(root, 'utenfor');
    mkdirSync(outside);
    writeFileSync(resolve(outside, 'mål.txt'), 'utenfor worktreet\n', 'utf8');

    const originDir = resolve(root, 'origin');
    const repoRoot = resolve(root, 'clone');
    git(root, 'init', '-q', '--initial-branch=main', originDir);
    write(originDir, 'README.md', '# test\n');
    commitAll(originDir, 'første');
    write(originDir, 'src/a.ts', 'export const a = 1;\n');
    write(originDir, 'src/dir/f.ts', 'export const f = 1;\n');
    write(originDir, 'other/b.ts', 'export const b = 1;\n');
    write(originDir, 'docs/x.md', '# x\n');
    write(originDir, '.github/workflows/ci.yml', 'name: ci\n');
    write(originDir, '.gitignore', 'ignored/\n');
    commitAll(originDir, 'andre');
    git(root, 'clone', '-q', originDir, repoRoot);

    config = {
      repoRoot,
      stateDir: resolve(root, 'state'),
      auditDir: resolve(root, 'audit'),
      worktreeDir: resolve(root, 'worktrees'),
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

    wt = await createWorktree(config, 'scope-test', 1, 'agent/', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('createWorktree lagrer base-commiten', () => {
    expect(wt.baseSha).toBe(git(config.repoRoot, 'rev-parse', 'origin/main').trim());
  });

  it('tillater en endring innenfor allowedPaths og returnerer sjekket commit', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    write(wt.path, 'docs/ny.md', '# ny\n');
    commitAll(wt.path);

    const result = await assertDiffWithinScope(config, contract(), wt);
    expect(result.files).toEqual(['docs/ny.md', 'src/a.ts']);
    expect(result.headSha).toBe(git(wt.path, 'rev-parse', 'HEAD').trim());
    expect(result.baseSha).toBe(wt.baseSha);
  });

  it('avviser endring utenfor allowedPaths', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    write(wt.path, 'other/b.ts', 'export const b = 2;\n');
    commitAll(wt.path);

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('avviser endring i disallowedPaths', async () => {
    write(wt.path, 'src/secret/key.ts', 'export const k = 1;\n');
    commitAll(wt.path);

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'src/secret/key.ts', rule: 'disallowed' },
    ]);
  });

  it('avviser hard-blokkerte filer selv med allowedPaths ["**"], men tillater .env.example', async () => {
    write(wt.path, '.github/workflows/ci.yml', 'name: hacked\n');
    write(wt.path, 'src/.env', 'TOKEN=x\n');
    write(wt.path, 'src/.env.example', 'TOKEN=\n');
    commitAll(wt.path);

    const v = await violationsOf(config, contract(['**'], []), wt);
    expect(v).toContainEqual({ path: '.github/workflows/ci.yml', rule: 'hard_blocked' });
    expect(v).toContainEqual({ path: 'src/.env', rule: 'hard_blocked' });
    expect(v.some((x) => x.path === 'src/.env.example')).toBe(false);
  });

  it('avviser sletting utenfor scope', async () => {
    git(wt.path, 'rm', '-q', 'other/b.ts');
    commitAll(wt.path);
    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('tillater sletting innenfor scope', async () => {
    git(wt.path, 'rm', '-q', 'src/a.ts');
    commitAll(wt.path);
    const result = await assertDiffWithinScope(config, contract(), wt);
    expect(result.files).toEqual(['src/a.ts']);
  });

  it('avviser flytting/omdøping fra en sti utenfor scope (begge stiene sjekkes)', async () => {
    git(wt.path, 'mv', 'other/b.ts', 'src/b.ts');
    commitAll(wt.path);
    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('avviser flytting fra scope til en forbudt sti', async () => {
    git(wt.path, 'mv', 'src/a.ts', '.github/workflows/a.ts');
    commitAll(wt.path);
    const v = await violationsOf(config, contract(), wt);
    expect(v).toContainEqual({ path: '.github/workflows/a.ts', rule: 'outside_allowed' });
    expect(v).toContainEqual({ path: '.github/workflows/a.ts', rule: 'hard_blocked' });
  });

  it('avviser usporede filer utenfor scope, men ikke ignorerte filer', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    write(wt.path, 'other/ny.ts', 'export const n = 1;\n');
    write(wt.path, 'ignored/stor.bin', 'x\n');

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/ny.ts', rule: 'outside_allowed' },
    ]);
  });

  it('avviser ukommiterte endringer i sporede filer utenfor scope', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    write(wt.path, 'other/b.ts', 'export const b = 3;\n');

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('ser en commitet endring selv om arbeidskopien er tilbakestilt', async () => {
    write(wt.path, 'other/b.ts', 'export const b = 2;\n');
    commitAll(wt.path);
    write(wt.path, 'other/b.ts', 'export const b = 1;\n'); // som basen, ikke commitet
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('avviser en commitet symlenke, også innenfor scope', async () => {
    symlinkSync('../other/b.ts', resolve(wt.path, 'src/lenke.ts'));
    commitAll(wt.path);
    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'src/lenke.ts', rule: 'symlink' },
    ]);
  });

  it('avviser en usporet symlenke som peker ut av worktreet', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    symlinkSync(resolve(outside, 'mål.txt'), resolve(wt.path, 'src/ut.ts'));

    const v = await violationsOf(config, contract(), wt);
    expect(v).toContainEqual({ path: 'src/ut.ts', rule: 'symlink' });
    expect(v).toContainEqual({ path: 'src/ut.ts', rule: 'escapes_worktree' });
  });

  it('avviser skriving utenfor worktreet via en mappe byttet ut med symlenke', async () => {
    rmSync(resolve(wt.path, 'src/dir'), { recursive: true });
    writeFileSync(resolve(outside, 'f.ts'), 'export const f = 666;\n', 'utf8');
    symlinkSync(outside, resolve(wt.path, 'src/dir'));

    const v = await violationsOf(config, contract(), wt);
    expect(v).toContainEqual({ path: 'src/dir', rule: 'symlink' });
    expect(v).toContainEqual({ path: 'src/dir/f.ts', rule: 'escapes_worktree' });
  });

  it('avviser en submodul (gitlink)', async () => {
    const sha = git(wt.path, 'rev-parse', 'HEAD').trim();
    git(wt.path, 'update-index', '--add', '--cacheinfo', `160000,${sha},src/sub`);
    git(wt.path, 'commit', '-q', '-m', 'submodul');

    expect(await violationsOf(config, contract(), wt)).toContainEqual({
      path: 'src/sub',
      rule: 'submodule',
    });
  });

  it('avviser endret .gitmodules', async () => {
    write(wt.path, '.gitmodules', '[submodule "x"]\n\tpath = src/x\n\turl = ../x\n');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);

    const v = await violationsOf(config, contract(['**'], []), wt);
    expect(v).toContainEqual({ path: '.gitmodules', rule: 'hard_blocked' });
  });

  it('avviser et innebygd, usporet git-repo', async () => {
    write(wt.path, 'src/nested/x.ts', 'x\n');
    git(resolve(wt.path, 'src/nested'), 'init', '-q');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    git(wt.path, 'add', 'src/a.ts');
    git(wt.path, 'commit', '-q', '-m', 'endring');

    expect(await violationsOf(config, contract(), wt)).toContainEqual({
      path: 'src/nested/',
      rule: 'submodule',
    });
  });

  it('kaster når det ikke finnes noen endringer (fail closed)', async () => {
    await expect(assertDiffWithinScope(config, contract(), wt)).rejects.toThrow(
      ScopeInspectionError
    );
  });

  it('kaster når HEAD ikke er agentgrenen', async () => {
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);
    git(wt.path, 'checkout', '-q', '--detach', 'HEAD');
    write(wt.path, 'other/b.ts', 'export const b = 2;\n');
    commitAll(wt.path);

    await expect(assertDiffWithinScope(config, contract(), wt)).rejects.toThrow(
      /er ikke agentgrenen/
    );
  });

  it('kaster når agentgrenen ikke bygger på base-commiten (historikk omskrevet)', async () => {
    git(wt.path, 'reset', '-q', '--hard', 'HEAD~1');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);

    await expect(assertDiffWithinScope(config, contract(), wt)).rejects.toThrow(
      /bygger ikke på base-commiten/
    );
  });

  it('lar seg ikke lure av at agenten flytter origin/main', async () => {
    write(wt.path, 'other/b.ts', 'export const b = 2;\n');
    commitAll(wt.path);
    // refs deles mellom worktrees: agenten kan peke origin/main på sin egen commit.
    git(wt.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(wt.path, 'src/a.ts', 'export const a = 2;\n');
    commitAll(wt.path);

    expect(await violationsOf(config, contract(), wt)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('uten lagret base-commit brukes merge-base mot origin/<baseBranch>', async () => {
    write(wt.path, 'other/b.ts', 'export const b = 2;\n');
    commitAll(wt.path);
    const { baseSha: _ignored, ...utenBase } = wt;
    void _ignored;

    expect(await violationsOf(config, contract(), utenBase)).toEqual([
      { path: 'other/b.ts', rule: 'outside_allowed' },
    ]);
  });

  it('kaster ved feil under git-inspeksjon (worktreet finnes ikke)', async () => {
    await expect(
      assertDiffWithinScope(config, contract(), { ...wt, path: resolve(root, 'finnes-ikke') })
    ).rejects.toThrow(ScopeInspectionError);
  });
});
