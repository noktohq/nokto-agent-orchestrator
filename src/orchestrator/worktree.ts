import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCommand } from '../providers/exec.js';
import type { OrchestratorConfig } from '../config.js';

export class WorktreeError extends Error {}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /**
   * Commiten worktreet ble opprettet fra. Scope-vakten differ mot denne, ikke mot
   * `origin/<baseBranch>`, som agenten kan flytte (refs deles mellom worktrees).
   */
  baseSha?: string;
}

/**
 * Oppretter en isolert git worktree + ny branch fra baseBranch. Agenter
 * arbeider ALDRI direkte i hovedarbeidskopien — dette er den eneste
 * offisielle måten orkestratoren gir en implementeringsagent et sted å
 * skrive filer på.
 */
export async function createWorktree(
  config: OrchestratorConfig,
  taskId: string,
  attempt: number,
  branchPrefix: string,
  baseBranch: string
): Promise<WorktreeHandle> {
  if (!existsSync(config.worktreeDir)) mkdirSync(config.worktreeDir, { recursive: true });

  const branch = `${branchPrefix}${taskId}-${attempt}`;
  const path = resolve(config.worktreeDir, `${taskId}-${attempt}`);

  if (existsSync(path)) {
    throw new WorktreeError(`Worktree-sti finnes allerede: ${path}. Rydd opp før nytt forsøk.`);
  }

  const fetchRes = await runCommand(['git', 'fetch', 'origin', baseBranch], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 60_000,
    readOnly: true,
  });
  if (!fetchRes.ok) {
    throw new WorktreeError(
      `git fetch origin ${baseBranch} feilet: ${fetchRes.stderr.slice(0, 300)}`
    );
  }

  const revRes = await runCommand(
    ['git', 'rev-parse', '--verify', '--end-of-options', `origin/${baseBranch}^{commit}`],
    { cwd: config.repoRoot, repoRoot: config.repoRoot, timeoutMs: 15_000, readOnly: true }
  );
  const baseSha = revRes.stdout.trim();
  if (!revRes.ok || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseSha)) {
    throw new WorktreeError(
      `Fant ikke commit for origin/${baseBranch}: ${revRes.stderr.slice(0, 300)}`
    );
  }

  const addRes = await runCommand(['git', 'worktree', 'add', '-b', branch, path, baseSha], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 60_000,
  });
  if (!addRes.ok) {
    throw new WorktreeError(`git worktree add feilet: ${addRes.stderr.slice(0, 500)}`);
  }

  return { path, branch, baseSha };
}

export async function removeWorktree(
  config: OrchestratorConfig,
  handle: WorktreeHandle
): Promise<void> {
  const res = await runCommand(['git', 'worktree', 'remove', '--force', handle.path], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 30_000,
  });
  if (!res.ok && existsSync(handle.path)) {
    // Siste utvei — worktree remove kan feile hvis mappa allerede er delvis fjernet.
    rmSync(handle.path, { recursive: true, force: true });
    await runCommand(['git', 'worktree', 'prune'], {
      cwd: config.repoRoot,
      repoRoot: config.repoRoot,
      timeoutMs: 30_000,
    });
  }
}

export async function deleteLocalBranch(config: OrchestratorConfig, branch: string): Promise<void> {
  await runCommand(['git', 'branch', '-D', branch], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 15_000,
  }).catch(() => undefined);
}
