import { describe, expect, it } from 'vitest';
import { assertCommandAllowed, CommandNotAllowedError } from '../../src/security/allowlist.js';

const repoRoot = '/repo';
const worktree = '/repo/.worktrees/task-1';

describe('assertCommandAllowed', () => {
  it('blokkerer ukjente binærer', () => {
    expect(() => assertCommandAllowed(['rm', '-rf', '/'], { cwd: repoRoot, repoRoot })).toThrow(
      CommandNotAllowedError
    );
  });

  it('tillater lese-git-kommandoer i repoRoten', () => {
    expect(() =>
      assertCommandAllowed(['git', 'status'], { cwd: repoRoot, repoRoot })
    ).not.toThrow();
    expect(() => assertCommandAllowed(['git', 'diff'], { cwd: repoRoot, repoRoot })).not.toThrow();
    expect(() =>
      assertCommandAllowed(['git', 'branch', '-D', 'foo'], { cwd: repoRoot, repoRoot })
    ).not.toThrow();
    expect(() =>
      assertCommandAllowed(['git', 'worktree', 'remove', '--force', worktree], {
        cwd: repoRoot,
        repoRoot,
      })
    ).not.toThrow();
  });

  it('blokkerer muterende git-kommandoer i repoRoten', () => {
    expect(() =>
      assertCommandAllowed(['git', 'commit', '-m', 'x'], { cwd: repoRoot, repoRoot })
    ).toThrow(CommandNotAllowedError);
    expect(() =>
      assertCommandAllowed(['git', 'checkout', 'main'], { cwd: repoRoot, repoRoot })
    ).toThrow(CommandNotAllowedError);
  });

  it('tillater muterende git-kommandoer i en worktree', () => {
    expect(() =>
      assertCommandAllowed(['git', 'commit', '-m', 'x'], { cwd: worktree, repoRoot })
    ).not.toThrow();
  });

  it('blokkerer alltid destruktive subkommandoer, selv i en worktree', () => {
    expect(() =>
      assertCommandAllowed(['git', 'reset', '--hard'], { cwd: worktree, repoRoot })
    ).toThrow(CommandNotAllowedError);
    expect(() =>
      assertCommandAllowed(['git', 'clean', '-fd'], { cwd: worktree, repoRoot })
    ).toThrow(CommandNotAllowedError);
  });

  it('blokkerer git checkout -- <path>', () => {
    expect(() =>
      assertCommandAllowed(['git', 'checkout', '--', 'file.ts'], { cwd: worktree, repoRoot })
    ).toThrow(CommandNotAllowedError);
  });

  it('blokkerer force-push', () => {
    expect(() =>
      assertCommandAllowed(['git', 'push', '--force', 'origin', 'agent/x'], {
        cwd: worktree,
        repoRoot,
      })
    ).toThrow(CommandNotAllowedError);
    expect(() =>
      assertCommandAllowed(['git', 'push', 'origin', 'agent/x', '--force-with-lease'], {
        cwd: worktree,
        repoRoot,
      })
    ).toThrow(CommandNotAllowedError);
  });

  it('blokkerer push mot main', () => {
    expect(() =>
      assertCommandAllowed(['git', 'push', 'origin', 'main'], { cwd: worktree, repoRoot })
    ).toThrow(CommandNotAllowedError);
    expect(() =>
      assertCommandAllowed(['git', 'push', 'origin', 'HEAD:main'], { cwd: worktree, repoRoot })
    ).toThrow(CommandNotAllowedError);
  });

  it('tillater push av en commit-id mot en agent-branch', () => {
    expect(() =>
      assertCommandAllowed(
        ['git', 'push', '-u', 'origin', `${'c'.repeat(40)}:refs/heads/agent/task-1`],
        { cwd: worktree, repoRoot }
      )
    ).not.toThrow();
  });

  it('tillater andre allowlistede binærer', () => {
    expect(() =>
      assertCommandAllowed(['pnpm', 'run', 'lint'], { cwd: worktree, repoRoot })
    ).not.toThrow();
    expect(() =>
      assertCommandAllowed(['node', '--version'], { cwd: worktree, repoRoot })
    ).not.toThrow();
  });

  describe('push-vakt', () => {
    const policy = {
      protectedBranches: ['main', 'master', 'develop', 'trunk'],
      branchPrefix: 'agent/',
    };
    const push =
      (...args: string[]) =>
      () =>
        assertCommandAllowed(['git', 'push', ...args], {
          cwd: worktree,
          repoRoot,
          pushPolicy: policy,
        });

    it('blokkerer main og master uansett policy', () => {
      for (const target of ['main', 'master', 'Main', 'MASTER']) {
        expect(() =>
          assertCommandAllowed(['git', 'push', 'origin', target], { cwd: worktree, repoRoot })
        ).toThrow(CommandNotAllowedError);
        expect(push('origin', target)).toThrow(CommandNotAllowedError);
      }
    });

    it('blokkerer kontraktens baseBranch og origin/HEAD fra policyen', () => {
      expect(push('origin', `${'c'.repeat(40)}:refs/heads/develop`)).toThrow(/beskyttet gren/);
      expect(push('origin', `${'c'.repeat(40)}:refs/heads/trunk`)).toThrow(/beskyttet gren/);
    });

    it('blokkerer refspec-varianter mot en beskyttet gren', () => {
      for (const refspec of [
        'HEAD:main',
        'HEAD:refs/heads/main',
        'refs/heads/main',
        'agent/x:refs/heads/master',
        'agent/x:develop',
        'HEAD:refs/heads/trunk',
        `${'c'.repeat(40)}:refs/heads/main`,
      ]) {
        expect(push('origin', refspec), refspec).toThrow(CommandNotAllowedError);
      }
    });

    it('blokkerer +<beskyttet> og andre force-varianter', () => {
      expect(push('origin', '+main')).toThrow(/force-push/);
      expect(push('origin', '+HEAD:refs/heads/main')).toThrow(/force-push/);
      expect(push('origin', '+agent/x')).toThrow(/force-push/);
      expect(push('-uf', 'origin', 'agent/x')).toThrow(/force-push/);
      expect(push('--force-if-includes', 'origin', 'agent/x')).toThrow(/force-push/);
    });

    it('blokkerer push der git selv velger målet', () => {
      expect(push()).toThrow(CommandNotAllowedError);
      expect(push('origin')).toThrow(CommandNotAllowedError);
      expect(push('origin', 'HEAD')).toThrow(CommandNotAllowedError);
      expect(push('--all', 'origin')).toThrow(CommandNotAllowedError);
      expect(push('--mirror', 'origin')).toThrow(CommandNotAllowedError);
      expect(push('origin', 'refs/heads/*:refs/heads/*')).toThrow(CommandNotAllowedError);
    });

    it('blokkerer sletting, tags, andre refs og ukjente remoter/opsjoner', () => {
      expect(push('origin', ':agent/x')).toThrow(/sletter/);
      expect(push('--delete', 'origin', 'agent/x')).toThrow(CommandNotAllowedError);
      expect(push('--prune', 'origin', 'agent/x')).toThrow(CommandNotAllowedError);
      expect(push('--tags', 'origin', 'agent/x')).toThrow(CommandNotAllowedError);
      expect(push('origin', 'refs/tags/v1')).toThrow(CommandNotAllowedError);
      expect(push('--receive-pack=evil', 'origin', 'agent/x')).toThrow(CommandNotAllowedError);
      expect(push('https://example.invalid/x.git', 'agent/x')).toThrow(/kun origin/);
    });

    it('krever agentens grenprefiks på målet', () => {
      const sha = 'c'.repeat(40);
      expect(push('origin', `${sha}:refs/heads/feature/x`)).toThrow(/grenprefiks/);
      expect(push('origin', `${sha}:refs/heads/agent/`)).toThrow(CommandNotAllowedError);
      expect(push('origin', `${sha}:refs/heads/release`)).toThrow(/grenprefiks/);
      expect(push('origin', `${sha}:refs/heads/agent/../main`)).toThrow(CommandNotAllowedError);
      expect(() =>
        assertCommandAllowed(['git', 'push', 'origin', `${sha}:refs/heads/nokto/x`], {
          cwd: worktree,
          repoRoot,
          pushPolicy: { protectedBranches: [], branchPrefix: 'nokto/' },
        })
      ).not.toThrow();
    });

    it('krever at grenprefikset slutter på "/"', () => {
      const sha = 'c'.repeat(40);
      for (const branchPrefix of ['release', 'r', 'agent', '/']) {
        expect(
          () =>
            assertCommandAllowed(['git', 'push', 'origin', `${sha}:refs/heads/release-1`], {
              cwd: worktree,
              repoRoot,
              pushPolicy: { protectedBranches: [], branchPrefix },
            }),
          branchPrefix
        ).toThrow(/slutte på/);
      }
    });

    it('tillater bare <full commit-id>:refs/heads/<agentgren>', () => {
      expect(push('origin', `${'c'.repeat(40)}:refs/heads/agent/task-1-1`)).not.toThrow();
      expect(push('origin', `${'d'.repeat(64)}:refs/heads/agent/task-1-1`)).not.toThrow();
      expect(
        push('--no-verify', 'origin', `${'c'.repeat(40)}:refs/heads/agent/task-1-1`)
      ).not.toThrow();
    });

    it('blokkerer refspec uten kolon: remote.origin.push kan sende den til main', () => {
      expect(push('origin', 'agent/x')).toThrow(/uten eksplisitt mål/);
      expect(push('-u', 'origin', 'agent/task-1-1')).toThrow(/uten eksplisitt mål/);
      expect(push('origin', 'refs/heads/agent/x')).toThrow(/uten eksplisitt mål/);
    });

    it('blokkerer symbolske kilder og mål uten refs/heads/ (git DWIM)', () => {
      expect(push('origin', 'HEAD:agent/x')).toThrow(/refs\/heads/);
      expect(push('origin', 'HEAD:refs/heads/agent/x')).toThrow(/full commit-id/);
      expect(push('origin', 'agent/x:refs/heads/agent/x')).toThrow(/full commit-id/);
      expect(push('origin', `${'c'.repeat(12)}:refs/heads/agent/x`)).toThrow(/full commit-id/);
      expect(push('origin', `${'C'.repeat(40)}:refs/heads/agent/x`)).toThrow(/full commit-id/);
      expect(push('origin', `${'c'.repeat(40)}:agent/x`)).toThrow(/refs\/heads/);
    });

    it('globale git-opsjoner skjuler ikke subkommandoen', () => {
      expect(() =>
        assertCommandAllowed(
          [
            'git',
            '-c',
            'core.hooksPath=/dev/null',
            'push',
            'origin',
            `${'c'.repeat(40)}:refs/heads/main`,
          ],
          { cwd: worktree, repoRoot }
        )
      ).toThrow(/beskyttet gren/);
      expect(() =>
        assertCommandAllowed(['git', '-c', 'core.hooksPath=/dev/null', 'reset', '--hard'], {
          cwd: worktree,
          repoRoot,
        })
      ).toThrow(/blokkert/);
      expect(() =>
        assertCommandAllowed(
          [
            'git',
            '-c',
            'remote.origin.push=refs/heads/agent/x:refs/heads/main',
            'push',
            'origin',
            'agent/x',
          ],
          { cwd: worktree, repoRoot }
        )
      ).toThrow(/ikke tillatt/);
      expect(() =>
        assertCommandAllowed(['git', '-c', 'alias.st=!rm -rf /', 'st'], { cwd: worktree, repoRoot })
      ).toThrow(/ikke tillatt/);
      expect(() =>
        assertCommandAllowed(['git', '-C', '/repo', 'commit', '-m', 'x'], {
          cwd: worktree,
          repoRoot,
        })
      ).toThrow(/ikke tillatt/);
      expect(() =>
        assertCommandAllowed(['git', '-c', 'core.fsmonitor=false', 'diff'], {
          cwd: repoRoot,
          repoRoot,
        })
      ).not.toThrow();
    });
  });
});
