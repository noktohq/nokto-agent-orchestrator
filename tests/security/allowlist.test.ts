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

  it('tillater push mot en agent-branch', () => {
    expect(() =>
      assertCommandAllowed(['git', 'push', '-u', 'origin', 'agent/task-1'], {
        cwd: worktree,
        repoRoot,
      })
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
});
