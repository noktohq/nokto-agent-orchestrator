import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInvocationResult } from '../../src/types.js';

const runCommandMock =
  vi.fn<(argv: readonly string[], opts: unknown) => Promise<ProviderInvocationResult>>();
vi.mock('../../src/providers/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/exec.js')>()),
  runCommand: (argv: readonly string[], opts: unknown) => runCommandMock(argv, opts),
}));

const { MAX_CAPTURE_BYTES } = await import('../../src/providers/exec.js');
const {
  assertDiffWithinScope,
  checkPathAgainstScope,
  isHardBlockedPath,
  ScopeInspectionError,
  ScopeViolationError,
  unsafePathReason,
} = await import('../../src/security/scope.js');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const wtDir = mkdtempSync(resolve(tmpdir(), 'nokto-scope-mock-'));
afterAll(() => rmSync(wtDir, { recursive: true, force: true }));

function ok(stdout = ''): ProviderInvocationResult {
  return { ok: true, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}
function fail(exitCode: number, stderr = 'fatal: noe gikk galt'): ProviderInvocationResult {
  return { ok: false, exitCode, stdout: '', stderr, durationMs: 1, timedOut: false };
}

interface GitAnswers {
  revParse?: ProviderInvocationResult;
  isAncestor?: ProviderInvocationResult;
  committedNames?: ProviderInvocationResult;
  worktreeNames?: ProviderInvocationResult;
  untracked?: ProviderInvocationResult;
  committedRaw?: ProviderInvocationResult;
  worktreeRaw?: ProviderInvocationResult;
}

function rawLine(path: string, src = '100644', dst = '100644'): string {
  return `:${src} ${dst} ${'1'.repeat(40)} ${'2'.repeat(40)} M\0${path}\0`;
}

/** Svarer på git-kallene til assertDiffWithinScope ut fra argumentene, ikke rekkefølgen. */
function fakeGit(answers: GitAnswers = {}): void {
  runCommandMock.mockImplementation(async (argv) => {
    const args = argv.slice(3); // git -c core.fsmonitor=false …
    expect(argv.slice(0, 3)).toEqual(['git', '-c', 'core.fsmonitor=false']);
    if (args[0] === 'rev-parse') return answers.revParse ?? ok(`${HEAD}\n`);
    if (args[0] === 'merge-base') return answers.isAncestor ?? ok();
    if (args[0] === 'ls-files') return answers.untracked ?? ok();
    if (args[0] === 'diff') {
      const committed = args.includes(HEAD);
      if (args.includes('--name-only')) {
        return committed
          ? (answers.committedNames ?? ok('src/a.ts\0'))
          : (answers.worktreeNames ?? ok('src/a.ts\0'));
      }
      return committed
        ? (answers.committedRaw ?? ok(rawLine('src/a.ts')))
        : (answers.worktreeRaw ?? ok(rawLine('src/a.ts')));
    }
    throw new Error(`Uventet git-kall: ${argv.join(' ')}`);
  });
}

function contract() {
  return {
    id: 'scope-mock',
    title: 'x',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['src/**'], disallowedPaths: [] },
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
    metadata: { labels: [] },
  };
}

const config = { repoRoot: '/repo' } as unknown as Parameters<typeof assertDiffWithinScope>[0];
const wt = () => ({ path: wtDir, branch: 'agent/scope-mock-1', baseSha: BASE });

describe('path-policy (felles for plan og diff)', () => {
  it('avviser usikre stier', () => {
    expect(unsafePathReason('/etc/passwd')).toMatch(/absolutt/);
    expect(unsafePathReason('src\\a.ts')).toMatch(/backslash/);
    expect(unsafePathReason('src/../.github/workflows/x.yml')).toMatch(/\.\./);
    expect(unsafePathReason('src//a.ts')).toMatch(/tomt/);
    expect(unsafePathReason('src/')).toMatch(/tomt/);
    expect(unsafePathReason('')).toMatch(/tom sti/);
    expect(unsafePathReason('C:/x.ts')).toMatch(/Windows/);
    expect(unsafePathReason('c:x.ts')).toMatch(/Windows/);
    expect(unsafePathReason('src/./a.ts')).not.toBeNull();
    expect(unsafePathReason('src/a\nb.ts')).toMatch(/kontrolltegn/);
    expect(unsafePathReason('src/a..b.ts')).toBeNull();
    expect(unsafePathReason('src/a.ts')).toBeNull();
  });

  it('usikre stier gir ett brudd og matches ikke mot glob', () => {
    const v = checkPathAgainstScope('src/../../etc/passwd', {
      allowedPaths: ['**'],
      disallowedPaths: [],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('unsafe_path');
  });

  it('hard-blokkerer git-metadata, workflows, .env og config.json — uansett store/små bokstaver', () => {
    for (const p of [
      '.git/config',
      'sub/.git/hooks/pre-push',
      '.github/workflows/ci.yml',
      '.GitHub/Workflows/ci.yml',
      '.env',
      'apps/web/.env.local',
      'config.json',
      '.gitmodules',
    ]) {
      expect(isHardBlockedPath(p), p).toBe(true);
    }
    expect(isHardBlockedPath('apps/web/.env.example')).toBe(false);
    expect(isHardBlockedPath('src/a.ts')).toBe(false);
  });
});

describe('assertDiffWithinScope — fail closed (mocket git)', () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it('godtar en ren diff innenfor scope', async () => {
    fakeGit();
    const result = await assertDiffWithinScope(config, contract(), wt());
    expect(result).toEqual({ baseSha: BASE, headSha: HEAD, files: ['src/a.ts'] });
    for (const [argv, opts] of runCommandMock.mock.calls) {
      expect(argv).not.toContain('--ext-diff');
      expect(opts).toMatchObject({ readOnly: true, cwd: wtDir });
    }
  });

  it('kaster når git-output ikke er \\0-terminert (ufullstendig)', async () => {
    fakeGit({ committedNames: ok('src/a.ts\0other/b.t') });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(
      /ikke \\0-terminert/
    );
  });

  it('kaster når git-output er nær fangstgrensen (kan være avkortet)', async () => {
    const big = 'src/a.ts\0'.repeat(Math.ceil(MAX_CAPTURE_BYTES / 9));
    fakeGit({ untracked: ok(big) });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(/fangstgrensen/);
  });

  it('kaster når git feiler', async () => {
    fakeGit({ worktreeNames: fail(128) });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(
      ScopeInspectionError
    );
  });

  it('kaster ved tidsavbrudd selv med exit 0', async () => {
    fakeGit({ untracked: { ...ok(''), timedOut: true } });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(/tidsavbrudd/);
  });

  it('kaster når runCommand selv kaster (f.eks. allowlist)', async () => {
    runCommandMock.mockRejectedValue(new Error('nektet'));
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(
      ScopeInspectionError
    );
  });

  it('kaster når --raw og --name-only er uenige', async () => {
    fakeGit({ committedRaw: ok(rawLine('src/a.ts') + rawLine('other/skjult.ts')) });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(/inkonsistent/);
  });

  it('kaster ved uventet --raw-format', async () => {
    fakeGit({ worktreeRaw: ok('noe helt annet\0src/a.ts\0') });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(/uventet format/);
  });

  it('kaster når rev-parse ikke gir en commit-id', async () => {
    fakeGit({ revParse: ok('ikke-en-sha\n') });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(
      ScopeInspectionError
    );
  });

  it('kaster når lagret base-commit er ugyldig', async () => {
    fakeGit();
    await expect(
      assertDiffWithinScope(config, contract(), { ...wt(), baseSha: 'origin/main' })
    ).rejects.toThrow(/base-commit/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('kaster når det ikke finnes endringer', async () => {
    fakeGit({
      committedNames: ok(''),
      worktreeNames: ok(''),
      committedRaw: ok(''),
      worktreeRaw: ok(''),
    });
    await expect(assertDiffWithinScope(config, contract(), wt())).rejects.toThrow(
      /Ingen endringer/
    );
  });

  it('rapporterer usikre stier fra git som brudd', async () => {
    fakeGit({ committedNames: ok('src/a.ts\0/etc/passwd\0'), committedRaw: ok('') });
    const err = await assertDiffWithinScope(config, contract(), wt()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeViolationError);
    expect((err as InstanceType<typeof ScopeViolationError>).violations).toContainEqual(
      expect.objectContaining({ path: '/etc/passwd', rule: 'unsafe_path' })
    );
  });

  it('avviser symlenke- og gitlink-modus fra --raw', async () => {
    fakeGit({
      committedNames: ok('src/a.ts\0src/sub\0'),
      committedRaw: ok(
        rawLine('src/a.ts', '100644', '120000') + rawLine('src/sub', '000000', '160000')
      ),
    });
    const err = await assertDiffWithinScope(config, contract(), wt()).catch((e: unknown) => e);
    const rules = (err as InstanceType<typeof ScopeViolationError>).violations.map((v) => v.rule);
    expect(rules).toContain('symlink');
    expect(rules).toContain('submodule');
  });
});
