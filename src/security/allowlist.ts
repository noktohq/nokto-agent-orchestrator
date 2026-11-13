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

/**
 * Regler for `git push`. Uten policy gjelder standarden: main og master er beskyttet,
 * og målet må være en gren under `agent/`.
 */
export interface PushPolicy {
  /** Grener som aldri kan være push-mål, i tillegg til main og master. */
  protectedBranches: readonly string[];
  /** Push-mål må være `refs/heads/<branchPrefix>…`. */
  branchPrefix: string;
}

export const ALWAYS_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];
export const DEFAULT_PUSH_BRANCH_PREFIX = 'agent/';

export interface CommandContext {
  /** Absolutt sti kommandoen kjøres fra. */
  cwd: string;
  /** Repoets rot — mutasjons-git-kommandoer nektes her, kun i worktrees. */
  repoRoot: string;
  /** Sett true for rene lese-git-kommandoer som får kjøre i repoRoot. */
  readOnly?: boolean;
  /** Push-regler for denne kommandoen. Utelatt = standardpolicy (se PushPolicy). */
  pushPolicy?: PushPolicy;
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

/**
 * `-c`-verdier orkestratoren selv bruker. Alt annet nektes: `-c alias.x=!cmd`,
 * `-c remote.origin.push=…`, `-c core.sshCommand=…` o.l. kan kjøre kode eller
 * sende en push et annet sted enn argumentene viser.
 */
const ALLOWED_GIT_CONFIG_OVERRIDES = new Set([
  'core.fsmonitor=false',
  'core.hookspath=/dev/null',
  'core.quotepath=false',
  'color.ui=false',
  'commit.gpgsign=false',
]);

const ALLOWED_GIT_GLOBAL_FLAGS = new Set(['--no-pager']);

/**
 * Skiller globale git-opsjoner (`git -c k=v push …`) fra subkommandoen, slik at
 * reglene under gjelder den faktiske subkommandoen og ikke `-c`.
 */
function splitGitInvocation(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (!a.startsWith('-')) break;
    if (a === '-c') {
      const kv = args[i + 1];
      if (kv === undefined) {
        throw new CommandNotAllowedError('git -c mangler verdi.');
      }
      if (!ALLOWED_GIT_CONFIG_OVERRIDES.has(kv.toLowerCase())) {
        throw new CommandNotAllowedError(`git -c "${kv}" er ikke tillatt.`);
      }
      i += 2;
      continue;
    }
    if (ALLOWED_GIT_GLOBAL_FLAGS.has(a)) {
      i += 1;
      continue;
    }
    throw new CommandNotAllowedError(
      `Global git-opsjon "${a}" er ikke tillatt (f.eks. -C, --git-dir og --work-tree kan flytte kommandoen ut av worktreet).`
    );
  }
  return args.slice(i);
}

function assertGitCommandAllowed(rawArgs: readonly string[], ctx: CommandContext): void {
  const args = splitGitInvocation(rawArgs);
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
    assertPushAllowed(args.slice(1), ctx);
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

const PUSH_FLAGS_ALLOWED = new Set([
  '-u',
  '--set-upstream',
  '--no-verify',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--porcelain',
  '-n',
  '--dry-run',
  '--atomic',
  '--progress',
  '--no-progress',
]);
const PUSH_SHORT_FLAGS_ALLOWED = new Set(['u', 'q', 'v', 'n']);
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option']);

/** Gyldig grennavn uten git-spesialsyntaks (`..`, `@{`, `*`, `~`, `^`, `:` osv.). */
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function forceError(flag: string): CommandNotAllowedError {
  return new CommandNotAllowedError(
    `git push med "${flag}" er blokkert — force-push er aldri tillatt.`
  );
}

/**
 * Push-vakt. Strengeste variant: et push-mål må være en eksplisitt gren under
 * agentens grenprefiks, og aldri en beskyttet gren (main, master, kontraktens
 * baseBranch, origin/HEAD). Alt som lar git selv velge mål (ingen refspec, `HEAD`
 * uten mål, `--all`, `--mirror`, mønster-refspecs), sletting, force og tags nektes.
 */
function assertPushAllowed(args: readonly string[], ctx: CommandContext): void {
  const policy = ctx.pushPolicy;
  const prefix = policy?.branchPrefix ?? DEFAULT_PUSH_BRANCH_PREFIX;
  const protectedSet = new Set(
    [...ALWAYS_PROTECTED_BRANCHES, ...(policy?.protectedBranches ?? []), 'HEAD'].map((b) =>
      b.toLowerCase()
    )
  );

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (FORCE_FLAGS.has(a) || a.startsWith('--force')) throw forceError(a);
    if (PUSH_FLAGS_ALLOWED.has(a)) continue;
    if (PUSH_OPTIONS_WITH_VALUE.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('--push-option=')) continue;
    if (/^-[A-Za-z]{2,}$/.test(a)) {
      const letters = a.slice(1).split('');
      if (letters.includes('f')) throw forceError(a);
      if (letters.every((l) => PUSH_SHORT_FLAGS_ALLOWED.has(l))) continue;
    }
    throw new CommandNotAllowedError(`git push-opsjon "${a}" er ikke tillatt.`);
  }

  const [remote, ...refspecs] = positional;
  if (remote === undefined || refspecs.length === 0) {
    throw new CommandNotAllowedError(
      'git push uten eksplisitt remote og refspec er blokkert — målet ville blitt valgt av git-konfigurasjonen.'
    );
  }
  if (remote !== 'origin') {
    throw new CommandNotAllowedError(
      `git push til "${remote}" er blokkert — kun origin er tillatt.`
    );
  }

  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) throw forceError(refspec);
    if (refspec.includes('*')) {
      throw new CommandNotAllowedError(`git push med mønster-refspec "${refspec}" er blokkert.`);
    }
    const colon = refspec.indexOf(':');
    const src = colon === -1 ? refspec : refspec.slice(0, colon);
    const dst = colon === -1 ? refspec : refspec.slice(colon + 1);
    if (src === '') {
      throw new CommandNotAllowedError(`git push "${refspec}" sletter en remote-ref — blokkert.`);
    }
    if (dst === '' || dst.includes(':')) {
      throw new CommandNotAllowedError(`git push-refspec "${refspec}" er ugyldig.`);
    }

    let branch: string;
    if (dst.startsWith('refs/heads/')) {
      branch = dst.slice('refs/heads/'.length);
    } else if (dst.startsWith('refs/')) {
      throw new CommandNotAllowedError(
        `git push mot "${dst}" er blokkert — kun grener (refs/heads/) er tillatt.`
      );
    } else {
      branch = dst;
    }

    if (protectedSet.has(branch.toLowerCase())) {
      throw new CommandNotAllowedError(
        `git push mot "${branch}" er blokkert. Orkestratoren pusher aldri direkte til en beskyttet gren (${[...protectedSet].join(', ')}) — kun til agent-branches, PR kreves for merge.`
      );
    }
    if (
      !SAFE_BRANCH_RE.test(branch) ||
      branch.includes('..') ||
      branch.includes('//') ||
      branch.endsWith('/') ||
      branch.endsWith('.lock') ||
      branch.split('/').some((seg) => seg.startsWith('.'))
    ) {
      throw new CommandNotAllowedError(`git push mot "${dst}" er blokkert — ugyldig grennavn.`);
    }
    if (!branch.startsWith(prefix) || branch.length <= prefix.length) {
      throw new CommandNotAllowedError(
        `git push mot "${branch}" er blokkert — målet må være en gren under agentens grenprefiks "${prefix}".`
      );
    }
  }
}
