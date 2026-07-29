/**
 * Command allowlist og destruktiv-kommando-blokkering.
 *
 * Alle kommandoer orkestratoren kjører — enten internt (git-operasjoner) eller
 * fra en oppgavekontrakts testRequirements.commands — går gjennom
 * assertCommandAllowed() før spawn. Ingen shell-strenger tolkes; kall skjer
 * alltid som argv-arrays (execFile, aldri exec/shell:true), så command
 * injection via mellomrom/`;`/`&&` er ikke mulig i utgangspunktet. Denne
 * modulen er et andre lag: den nekter binærer og delkommandoer som ikke er
 * eksplisitt tillatt.
 */

export class CommandNotAllowedError extends Error {}

const ALLOWED_BINARIES = new Set([
  'git',
  'pnpm',
  'npm',
  'npx',
  'node',
  'tsc',
  'vitest',
  'eslint',
  'prettier',
  'python3',
  'pytest',
]);

const BLOCKED_GIT_SUBCOMMANDS = new Set(['reset', 'clean', 'filter-branch', 'filter-repo']);

const FORCE_FLAGS = new Set(['-f', '--force', '--force-with-lease']);

export interface CommandContext {
  /** Absolutt sti kommandoen kjøres fra. */
  cwd: string;
  /** Repoets rot — mutasjons-git-kommandoer nektes her, kun i worktrees. */
  repoRoot: string;
  /** Sett true for rene lese-git-kommandoer som får kjøre i repoRoot. */
  readOnly?: boolean;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'branch',
  'worktree',
  'remote',
  'fetch',
  'ls-files',
  'ls-remote',
]);

/**
 * "Trygg-i-repoRoten"-sjekk. Formålet er å hindre at agenter muterer
 * SPORET INNHOLD i hovedarbeidskopien (checkout, commit, merge, reset osv.).
 * `branch` (inkl. -D) og `worktree` rører kun refs/mapper utenfor det
 * spore de arbeidstreet — trygt å kjøre fra repoRoot som orkestrator-
 * opprydding, derfor inkludert her selv om de teknisk sett muterer state.
 */
function isReadOnlyGitInvocation(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined) return false;
  return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
}

export function assertCommandAllowed(argv: readonly string[], ctx: CommandContext): void {
  const [bin, ...args] = argv;
  if (!bin) {
    throw new CommandNotAllowedError('Tom kommando er ikke tillatt.');
  }
  if (!ALLOWED_BINARIES.has(bin)) {
    throw new CommandNotAllowedError(
      `Binær "${bin}" er ikke på allowlisten. Tillatt: ${[...ALLOWED_BINARIES].join(', ')}`
    );
  }

  if (bin === 'git') {
    assertGitCommandAllowed(args, ctx);
  }
}

function assertGitCommandAllowed(args: readonly string[], ctx: CommandContext): void {
  const sub = args[0];
  if (sub === undefined) {
    throw new CommandNotAllowedError('git-kommando mangler subkommando.');
  }

  if (BLOCKED_GIT_SUBCOMMANDS.has(sub)) {
    throw new CommandNotAllowedError(
      `git ${sub} er blokkert — destruktiv historikk-/arbeidskopi-operasjon.`
    );
  }

  if (sub === 'push') {
    assertPushAllowed(args, ctx);
  }

  if (sub === 'checkout' && args.includes('--')) {
    throw new CommandNotAllowedError(
      'git checkout -- <path> er blokkert — kan forkaste ukommitert arbeid.'
    );
  }

  const readOnly = isReadOnlyGitInvocation([...args]);
  const isNormalizedPath = (p: string): string => p.replace(/\/+$/, '');
  const inRepoRoot = isNormalizedPath(ctx.cwd) === isNormalizedPath(ctx.repoRoot);

  if (inRepoRoot && !readOnly && !ctx.readOnly) {
    throw new CommandNotAllowedError(
      `git ${sub} nektet i repo-roten (${ctx.repoRoot}). Muterende git-kommandoer skal kjøre i en isolert worktree, ikke i hovedarbeidskopien.`
    );
  }
}

function assertPushAllowed(args: readonly string[], ctx: CommandContext): void {
  for (const flag of args) {
    if (FORCE_FLAGS.has(flag)) {
      throw new CommandNotAllowedError(
        `git push med "${flag}" er blokkert — force-push er aldri tillatt.`
      );
    }
  }

  const protectedBranch = 'main';
  const targetsProtected = args.some((a) => {
    if (a === protectedBranch) return true;
    if (a.endsWith(`:${protectedBranch}`)) return true;
    if (a.endsWith(`/${protectedBranch}`)) return true;
    return false;
  });

  if (targetsProtected) {
    throw new CommandNotAllowedError(
      `git push mot "${protectedBranch}" er blokkert. Orkestratoren pusher aldri direkte til hovedbranchen — kun til agent-branches, PR kreves for merge.`
    );
  }

  void ctx;
}
