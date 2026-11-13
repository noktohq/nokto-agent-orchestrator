import { runCommand } from '../providers/exec.js';
import { ALWAYS_PROTECTED_BRANCHES, type PushPolicy } from './allowlist.js';
import type { OrchestratorConfig } from '../config.js';
import type { TaskContract } from '../types.js';

export interface ResolvedPushPolicy extends PushPolicy {
  /** Standardgrenen fra `refs/remotes/origin/HEAD`, eller null når den ikke kunne leses. */
  originHead: string | null;
}

/**
 * Leser repoets faktiske standardgren fra `refs/remotes/origin/HEAD`. Returnerer null
 * når ref-en mangler eller ikke kan tolkes (f.eks. en klone der origin/HEAD aldri ble satt).
 */
export async function resolveOriginHead(config: OrchestratorConfig): Promise<string | null> {
  try {
    const res = await runCommand(
      ['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: config.repoRoot, repoRoot: config.repoRoot, timeoutMs: 10_000, readOnly: true }
    );
    if (!res.ok) return null;
    const ref = res.stdout.trim();
    if (!ref.startsWith('origin/')) return null;
    const branch = ref.slice('origin/'.length);
    return branch === '' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Push-policy i push-øyeblikket: main, master, kontraktens baseBranch og origin/HEAD
 * (når den kan leses) er beskyttet, og målet må ligge under kontraktens grenprefiks.
 *
 * Kan ikke origin/HEAD leses, stoppes ikke pushen: kravet om grenprefiks gjør at
 * ingen gren utenfor `agent/…` (eller kontraktens prefiks) kan treffes uansett.
 */
export async function resolvePushPolicy(
  config: OrchestratorConfig,
  contract: TaskContract
): Promise<ResolvedPushPolicy> {
  const originHead = await resolveOriginHead(config);
  const protectedBranches = [
    ...new Set(
      [...ALWAYS_PROTECTED_BRANCHES, contract.git.baseBranch, originHead].filter(
        (b): b is string => typeof b === 'string' && b !== ''
      )
    ),
  ];
  return { protectedBranches, branchPrefix: contract.git.branchPrefix, originHead };
}
