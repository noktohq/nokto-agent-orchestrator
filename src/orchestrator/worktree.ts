import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCommand } from '../providers/exec.js';
import {
  assertCommitExists,
  fetchBaseSha,
  GIT_SAFETY_ARGS,
  remoteGitEnv,
} from '../security/gitIntegrity.js';
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

export interface CreateWorktreeOptions {
  /**
   * Base-commit fra et tidligere forsøk på samme oppgave. Settes den, hentes ingenting
   * fra remote: et senere forsøk skal ikke kunne få en base agenten i et tidligere
   * forsøk har plantet (refs og .git/config deles mellom worktrees).
   */
  baseSha?: string;
}

/**
 * Oppretter en isolert git worktree + ny branch fra baseBranch. Agenter
 * arbeider ALDRI direkte i hovedarbeidskopien — dette er den eneste
 * offisielle måten orkestratoren gir en implementeringsagent et sted å
 * skrive filer på.
 *
 * Basen hentes med en refspec orkestratoren eier (`refs/nokto/base/<oppgave>`), ikke fra
 * `origin/<baseBranch>`, og alle git-kall kjører med hooks og fsmonitor av.
 */
export async function createWorktree(
  config: OrchestratorConfig,
  taskId: string,
  attempt: number,
  branchPrefix: string,
  baseBranch: string,
  opts: CreateWorktreeOptions = {}
): Promise<WorktreeHandle> {
  if (!existsSync(config.worktreeDir)) mkdirSync(config.worktreeDir, { recursive: true });

  const branch = `${branchPrefix}${taskId}-${attempt}`;
  const path = resolve(config.worktreeDir, `${taskId}-${attempt}`);

  if (existsSync(path)) {
    throw new WorktreeError(`Worktree-sti finnes allerede: ${path}. Rydd opp før nytt forsøk.`);
  }

  let baseSha: string;
  try {
    if (opts.baseSha !== undefined) {
      await assertCommitExists(config, opts.baseSha);
      baseSha = opts.baseSha;
    } else {
      baseSha = await fetchBaseSha(config, taskId, baseBranch);
    }
  } catch (err) {
    throw new WorktreeError(
      `Fant ikke base-commit for origin/${baseBranch}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const addRes = await runCommand(
    ['git', ...GIT_SAFETY_ARGS, 'worktree', 'add', '-b', branch, path, baseSha],
    {
      cwd: config.repoRoot,
      repoRoot: config.repoRoot,
      timeoutMs: 60_000,
      env: remoteGitEnv(),
    }
  );
  if (!addRes.ok) {
    throw new WorktreeError(`git worktree add feilet: ${addRes.stderr.slice(0, 500)}`);
  }

  return { path, branch, baseSha };
}

export async function removeWorktree(
  config: OrchestratorConfig,
  handle: WorktreeHandle
): Promise<void> {
  const res = await runCommand(
    ['git', ...GIT_SAFETY_ARGS, 'worktree', 'remove', '--force', handle.path],
    {
      cwd: config.repoRoot,
      repoRoot: config.repoRoot,
      timeoutMs: 30_000,
      env: remoteGitEnv(),
    }
  );
  if (!res.ok && existsSync(handle.path)) {
    // Siste utvei — worktree remove kan feile hvis mappa allerede er delvis fjernet.
    rmSync(handle.path, { recursive: true, force: true });
    await runCommand(['git', ...GIT_SAFETY_ARGS, 'worktree', 'prune'], {
      cwd: config.repoRoot,
      repoRoot: config.repoRoot,
      timeoutMs: 30_000,
      env: remoteGitEnv(),
    });
  }
}

export async function deleteLocalBranch(config: OrchestratorConfig, branch: string): Promise<void> {
  await runCommand(['git', ...GIT_SAFETY_ARGS, 'branch', '-D', branch], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs: 15_000,
    env: remoteGitEnv(),
  }).catch(() => undefined);
}
