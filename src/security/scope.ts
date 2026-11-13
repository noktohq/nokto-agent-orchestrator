import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MAX_CAPTURE_BYTES, runCommand } from '../providers/exec.js';
import { matchesAnyGlob } from './glob.js';
import { inspectionGitEnv } from './gitIntegrity.js';
import type { OrchestratorConfig } from '../config.js';
import type { ProviderInvocationResult, TaskContract } from '../types.js';

/**
 * Felles path-policy for oppgavekontrakter.
 *
 * Brukes to steder, med samme regler:
 * - validator.ts sjekker planens `filesExpectedToChange` (det agenten SIER den skal endre).
 * - assertDiffWithinScope() sjekker den faktiske diffen i worktreet (det agenten HAR endret)
 *   etter hver implementering og rett før push.
 *
 * Alt som ikke kan fastslås sikkert, avvises (fail closed).
 */

/**
 * Stier som aldri kan endres av en agent, uansett allowedPaths.
 *
 * - git-metadata og `.gitattributes` (kan skjule innhold for diff/skanning og velge
 *   filter-drivere), `.gitmodules`
 * - hele `.github/` (workflows, lokale actions, CODEOWNERS, dependabot) og CODEOWNERS
 *   andre steder: kjører i CI eller styrer hvem som må godkjenne
 * - `.husky/` (git-hooks hos utviklere) og `.npmrc` (registry/legitimasjon)
 * - hemmelighetsfiler (`.env`, `*.env`, `.env.*`, `config.json`)
 */
export const HARD_BLOCKED_GLOBS: readonly string[] = [
  '.git/**',
  '**/.git/**',
  '**/.gitattributes',
  '.gitmodules',
  '**/.gitmodules',
  '.github/**',
  'CODEOWNERS',
  'docs/CODEOWNERS',
  '.husky/**',
  '**/.npmrc',
  '**/.env',
  '**/*.env',
  '**/.env.*',
  '**/config.json',
];

/** Alltid tillatt selv om de matcher HARD_BLOCKED_GLOBS, f.eks. `.env.example`. */
export const HARD_BLOCK_EXCEPTIONS: readonly string[] = ['**/.env.example'];

export type ScopeRule =
  | 'unsafe_path'
  | 'outside_allowed'
  | 'disallowed'
  | 'hard_blocked'
  | 'symlink'
  | 'submodule'
  | 'merge_commit'
  | 'escapes_worktree';

export interface ScopeViolation {
  path: string;
  rule: ScopeRule;
  reason: string;
}

/** Brudd på scope i en faktisk diff. Oppgaven skal feile og aldri pushes. */
export class ScopeViolationError extends Error {
  constructor(
    message: string,
    readonly violations: readonly ScopeViolation[]
  ) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

/** Scope-sjekken kunne ikke gjennomføres sikkert (git-feil, ufullstendig output, tom diff). */
export class ScopeInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeInspectionError';
  }
}

/**
 * Returnerer en begrunnelse dersom stien er usikker, ellers null. Git rapporterer
 * alltid relative stier med `/` som skilletegn; alt annet behandles som forsøk på å
 * lure matchingen.
 */
export function unsafePathReason(path: string): string | null {
  if (path === '') return 'tom sti';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return 'kontrolltegn i stien';
  // Retningsstyring, nullbredde og BOM: kan få en sti til å se annerledes ut i PR-visningen.
  if (/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(path)) {
    return 'usynlige tegn eller retningsstyring i stien';
  }
  // U+FFFD: git-output som ikke var gyldig UTF-8. Enslige surrogater: ugyldig Unicode.
  if (
    path.includes('\ufffd') ||
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(path)
  ) {
    return 'ugyldig Unicode i stien';
  }
  if (path !== path.normalize('NFC')) return 'stien er ikke NFC-normalisert';
  if (path.startsWith('/')) return 'absolutt sti';
  if (path.includes('\\')) return 'backslash i stien';
  if (/^[a-zA-Z]:/.test(path)) return 'Windows-drev i stien';
  const segments = path.split('/');
  if (segments.some((s) => s === '')) return 'tomt stisegment';
  if (segments.some((s) => s === '..')) return '".." i stien';
  if (segments.some((s) => s === '.')) return '"." som stisegment';
  return null;
}

/**
 * Bretter en sti eller et mønster for matching som ikke skiller mellom store og små
 * bokstaver eller kompatibilitetsformer: NFKC + store→små bokstaver via store bokstaver,
 * så f.eks. `ſ` (U+017F) blir `s` og `.GitHub` blir `.github`.
 */
export function foldPath(path: string): string {
  return path.normalize('NFKC').toUpperCase().toLowerCase();
}

function matchesAnyFolded(path: string, patterns: readonly string[]): boolean {
  return matchesAnyGlob(foldPath(path), patterns.map(foldPath));
}

export function isHardBlockedPath(path: string): boolean {
  // Uten skille mellom store og små bokstaver: `.GIT/` og `.GitHub/Workflows/` på
  // filsystemer som ikke skiller (macOS, Windows) skal ikke slippe forbi.
  return (
    matchesAnyFolded(path, HARD_BLOCKED_GLOBS) && !matchesAnyFolded(path, HARD_BLOCK_EXCEPTIONS)
  );
}

/**
 * Sjekker én sti mot kontraktens scope. Samme regler for plan og diff.
 * Returnerer alle brudd (tom liste = tillatt).
 */
export function checkPathAgainstScope(
  path: string,
  scope: Pick<TaskContract['scope'], 'allowedPaths' | 'disallowedPaths'>
): ScopeViolation[] {
  const unsafe = unsafePathReason(path);
  if (unsafe) {
    return [
      {
        path,
        rule: 'unsafe_path',
        reason: `Filsti "${path}" er usikker (${unsafe}): ikke tillatt.`,
      },
    ];
  }

  const violations: ScopeViolation[] = [];
  if (!matchesAnyGlob(path, scope.allowedPaths)) {
    violations.push({
      path,
      rule: 'outside_allowed',
      reason: `Filsti "${path}" er utenfor tillatt scope (${scope.allowedPaths.join(', ')}).`,
    });
  }
  // allowedPaths matches eksakt (strengest), disallowedPaths uten skille mellom store og
  // små bokstaver: `src/Secrets/k.ts` havner i `src/secrets/` på macOS og Windows.
  if (matchesAnyFolded(path, scope.disallowedPaths)) {
    violations.push({
      path,
      rule: 'disallowed',
      reason: `Filsti "${path}" matcher en eksplisitt forbudt sti.`,
    });
  }
  if (isHardBlockedPath(path)) {
    violations.push({
      path,
      rule: 'hard_blocked',
      reason: `Filsti "${path}" er alltid blokkert (hemmeligheter/CI-rettigheter/git-metadata).`,
    });
  }
  return violations;
}

/** Margin under fangstgrensen i runCommand: output nær grensen regnes som avkortet. */
const CAPTURE_SAFETY_MARGIN = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Flere commits enn dette sjekkes ikke enkeltvis; oppgaven feiler (fail closed). */
export const MAX_COMMITS_CHECKED = 500;

/** Minste form av en worktree-referanse — kompatibel med WorktreeHandle. */
export interface ScopeWorktree {
  path: string;
  branch: string;
  /** Commit worktreet ble opprettet fra. Satt av createWorktree. */
  baseSha?: string;
}

export interface ScopeCheckResult {
  baseSha: string;
  /** Commiten som er sjekket — det er denne som skal pushes. */
  headSha: string;
  files: string[];
}

async function git(
  args: string[],
  config: OrchestratorConfig,
  worktreePath: string
): Promise<ProviderInvocationResult> {
  try {
    // core.fsmonitor=false og hooksPath=/dev/null: et program agenten har satt i
    // git-konfigurasjonen skal ikke kjøres av orkestratoren. inspectionGitEnv(): ingen
    // replace-objekter (refs/replace kan ellers vise et annet tre enn det som pushes),
    // ingen system-/global konfig og ingen arvede GIT_*-variabler.
    return await runCommand(
      ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: worktreePath,
        repoRoot: config.repoRoot,
        timeoutMs: GIT_TIMEOUT_MS,
        readOnly: true,
        env: inspectionGitEnv(),
      }
    );
  } catch (err) {
    throw new ScopeInspectionError(
      `git ${args[0] ?? ''} kunne ikke kjøres: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function requireOk(res: ProviderInvocationResult, what: string): void {
  if (!res.ok || res.exitCode !== 0 || res.timedOut) {
    throw new ScopeInspectionError(
      `${what} feilet (exit ${res.exitCode ?? 'n/a'}${res.timedOut ? ', tidsavbrudd' : ''}): ${res.stderr.trim().slice(0, 300)}`
    );
  }
}

/** Kaster dersom git-output kan være avkortet. */
function requireComplete(
  res: Pick<ProviderInvocationResult, 'stdout' | 'stdoutTruncated'>,
  what: string,
  nulTerminated: boolean
): void {
  const stdout = res.stdout;
  const bytes = Buffer.byteLength(stdout, 'utf8');
  if (res.stdoutTruncated === true || bytes >= MAX_CAPTURE_BYTES - CAPTURE_SAFETY_MARGIN) {
    throw new ScopeInspectionError(
      `${what}: output er nær fangstgrensen (${bytes} byte) og kan være avkortet.`
    );
  }
  if (nulTerminated && stdout !== '' && !stdout.endsWith('\0')) {
    throw new ScopeInspectionError(`${what}: output er ikke \\0-terminert (ufullstendig).`);
  }
}

async function gitSha(
  config: OrchestratorConfig,
  worktreePath: string,
  rev: string
): Promise<string> {
  const res = await git(
    ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`],
    config,
    worktreePath
  );
  requireOk(res, `git rev-parse ${rev}`);
  requireComplete(res, `git rev-parse ${rev}`, false);
  const sha = res.stdout.trim();
  if (!SHA_RE.test(sha)) {
    throw new ScopeInspectionError(`git rev-parse ${rev} ga ikke en gyldig commit-id.`);
  }
  return sha;
}

function splitNul(stdout: string): string[] {
  if (stdout === '') return [];
  return stdout.slice(0, -1).split('\0');
}

interface RawEntry {
  srcMode: string;
  dstMode: string;
  path: string;
}

/** Parser `git diff --raw -z --no-renames`: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0". */
function parseRaw(stdout: string, what: string): RawEntry[] {
  const parts = splitNul(stdout);
  if (parts.length % 2 !== 0) {
    throw new ScopeInspectionError(`${what}: uventet format (oddetall felt).`);
  }
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = parts[i] ?? '';
    const path = parts[i + 1] ?? '';
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/.exec(meta);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new ScopeInspectionError(`${what}: uventet format i "${meta.slice(0, 80)}".`);
    }
    entries.push({ srcMode: m[1], dstMode: m[2], path });
  }
  return entries;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Sjekker at stien i worktreet ikke peker ut av worktreet. For filer som finnes,
 * brukes realpath; for slettede filer sjekkes nærmeste eksisterende foreldermappe
 * (en symlenket mappe på veien skal ikke kunne sende skrivinger ut).
 */
function escapesWorktree(rootReal: string, worktreePath: string, relPath: string): boolean {
  let candidate = join(worktreePath, relPath);
  for (;;) {
    try {
      lstatSync(candidate);
      break;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return true;
      candidate = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return true;
  }
  return !isInside(rootReal, real);
}

async function gitCommonDirOf(config: OrchestratorConfig, wt: string): Promise<string> {
  const res = await git(['rev-parse', '--git-common-dir'], config, wt);
  requireOk(res, 'git rev-parse --git-common-dir');
  const dir = res.stdout.trim();
  if (dir === '') throw new ScopeInspectionError('Fant ikke repoets git-katalog.');
  return isAbsolute(dir) ? dir : resolve(wt, dir);
}

/**
 * Replace-refs og grafts lar git vise andre trær eller en annen historikk enn den som
 * pushes. Replace-objekter er av i alle vaktens git-kall (GIT_NO_REPLACE_OBJECTS), men
 * finnes de, er repoet tuklet med og oppgaven skal stoppe. Grafts påvirkes ikke av
 * GIT_NO_REPLACE_OBJECTS og avvises derfor alltid.
 */
async function assertNoHistoryOverrides(config: OrchestratorConfig, wt: string): Promise<void> {
  const replace = await git(['for-each-ref', '--format=%(refname)', 'refs/replace/'], config, wt);
  requireOk(replace, 'git for-each-ref refs/replace/');
  if (replace.stdout.trim() !== '') {
    throw new ScopeInspectionError(
      `Repoet har replace-refs (${replace.stdout.trim().split('\n')[0] ?? ''}): diff og push kan vise ulike trær.`
    );
  }
  const common = await gitCommonDirOf(config, wt);
  if (existsSync(join(common, 'info', 'grafts'))) {
    throw new ScopeInspectionError('Repoet har info/grafts: historikken kan være omskrevet.');
  }
}

interface CommitInspection {
  entries: RawEntry[];
  merges: string[];
}

/** Stier og moduser i hver enkelt commit i base..head, og merge-commits. */
async function inspectCommits(
  config: OrchestratorConfig,
  wt: string,
  baseSha: string,
  headSha: string
): Promise<CommitInspection> {
  const list = await git(['rev-list', '--parents', `${baseSha}..${headSha}`, '--'], config, wt);
  requireOk(list, 'git rev-list');
  requireComplete(list, 'git rev-list', false);
  const lines = list.stdout.split('\n').filter((l) => l !== '');
  if (lines.length > MAX_COMMITS_CHECKED) {
    throw new ScopeInspectionError(
      `Agentgrenen har ${lines.length} commits; høyst ${MAX_COMMITS_CHECKED} sjekkes enkeltvis.`
    );
  }

  const entries: RawEntry[] = [];
  const merges: string[] = [];
  for (const line of lines) {
    const ids = line.split(' ');
    if (!ids.every((id) => SHA_RE.test(id))) {
      throw new ScopeInspectionError(`git rev-list: uventet format i "${line.slice(0, 80)}".`);
    }
    const [commit, ...parents] = ids as [string, ...string[]];
    if (parents.length !== 1) {
      // Merge eller rotcommit: aldri en lineær etterkommer av basen.
      merges.push(commit);
      continue;
    }
    const what = `git diff-tree ${commit.slice(0, 12)}`;
    const res = await git(
      [
        'diff-tree',
        '-r',
        '-z',
        '--raw',
        '--no-renames',
        '--ignore-submodules=none',
        parents[0] as string,
        commit,
        '--',
      ],
      config,
      wt
    );
    requireOk(res, what);
    requireComplete(res, what, true);
    entries.push(...parseRaw(res.stdout, what));
  }
  return { entries, merges };
}

/**
 * Håndhever kontraktens scope mot det implementereren faktisk har endret i worktreet.
 *
 * Endringer = commits siden basen + ukommiterte endringer i sporede filer + usporede
 * filer som ikke er ignorert. Hver sti må være trygg, innenfor `allowedPaths`, utenfor
 * `disallowedPaths` og ikke hard-blokkert. Symlenker, submoduler/innebygde repoer og
 * stier som peker ut av worktreet avvises.
 *
 * Fail closed: feil fra git, output som kan være avkortet, HEAD som ikke er
 * agentgrenen, historikk som ikke bygger på basen, eller ingen endringer → kaster.
 *
 * @returns sjekket base- og HEAD-commit og alle endrede stier.
 * @throws ScopeViolationError ved brudd på scope, ScopeInspectionError når sjekken
 *   ikke kan gjennomføres.
 */
export async function assertDiffWithinScope(
  config: OrchestratorConfig,
  contract: TaskContract,
  worktree: ScopeWorktree
): Promise<ScopeCheckResult> {
  const wt = worktree.path;

  // Basen: helst commiten worktreet ble laget fra (lagret av orkestratoren), ikke en
  // ref agenten kan ha flyttet. Uten den: merge-base mot origin/<baseBranch>.
  let baseSha: string;
  if (worktree.baseSha !== undefined) {
    if (!SHA_RE.test(worktree.baseSha)) {
      throw new ScopeInspectionError('Worktreets base-commit er ikke en gyldig commit-id.');
    }
    baseSha = worktree.baseSha;
  } else {
    const mb = await git(
      ['merge-base', '--end-of-options', `origin/${contract.git.baseBranch}`, 'HEAD'],
      config,
      wt
    );
    requireOk(mb, 'git merge-base');
    baseSha = mb.stdout.trim();
    if (!SHA_RE.test(baseSha)) {
      throw new ScopeInspectionError('git merge-base ga ikke en gyldig commit-id.');
    }
  }

  // Først: replace-refs/grafts kan endre både trær og historikk vakten ser.
  await assertNoHistoryOverrides(config, wt);

  // Det som pushes er agentgrenen. HEAD må være den, ellers kan sjekk og push se
  // forskjellige commits.
  const headSha = await gitSha(config, wt, 'HEAD');
  const branchSha = await gitSha(config, wt, `refs/heads/${worktree.branch}`);
  if (headSha !== branchSha) {
    throw new ScopeInspectionError(
      `HEAD (${headSha.slice(0, 12)}) er ikke agentgrenen ${worktree.branch} (${branchSha.slice(0, 12)}).`
    );
  }

  const ancestor = await git(['merge-base', '--is-ancestor', baseSha, headSha], config, wt);
  if (ancestor.exitCode === 1 && !ancestor.timedOut) {
    throw new ScopeInspectionError(
      `Agentgrenen bygger ikke på base-commiten ${baseSha.slice(0, 12)} (historikk omskrevet).`
    );
  }
  requireOk(ancestor, 'git merge-base --is-ancestor');

  // --ignore-submodules=none: `diff.ignoreSubmodules=all` i delt konfig skjuler ellers
  // gitlinks fra både --raw og --name-only. --no-relative: `diff.relative` skal ikke
  // begrense diffen til en undermappe.
  const diffBase = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--ignore-submodules=none',
    '--no-relative',
    '-z',
  ];

  // Navn: commits (base..HEAD) og arbeidskopi (base..worktree, inkl. staged).
  const committedNames = await git(
    [...diffBase, '--name-only', baseSha, headSha, '--'],
    config,
    wt
  );
  requireOk(committedNames, 'git diff --name-only (commits)');
  requireComplete(committedNames, 'git diff --name-only (commits)', true);

  const worktreeNames = await git([...diffBase, '--name-only', baseSha, '--'], config, wt);
  requireOk(worktreeNames, 'git diff --name-only (arbeidskopi)');
  requireComplete(worktreeNames, 'git diff --name-only (arbeidskopi)', true);

  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], config, wt);
  requireOk(untracked, 'git ls-files --others');
  requireComplete(untracked, 'git ls-files --others', true);

  // Modus: symlenker (120000) og submoduler (160000).
  const committedRaw = await git([...diffBase, '--raw', baseSha, headSha, '--'], config, wt);
  requireOk(committedRaw, 'git diff --raw (commits)');
  requireComplete(committedRaw, 'git diff --raw (commits)', true);

  const worktreeRaw = await git([...diffBase, '--raw', baseSha, '--'], config, wt);
  requireOk(worktreeRaw, 'git diff --raw (arbeidskopi)');
  requireComplete(worktreeRaw, 'git diff --raw (arbeidskopi)', true);

  const rawEntries = [
    ...parseRaw(committedRaw.stdout, 'git diff --raw (commits)'),
    ...parseRaw(worktreeRaw.stdout, 'git diff --raw (arbeidskopi)'),
  ];

  const untrackedPaths = splitNul(untracked.stdout);
  const netFiles = new Set([
    ...splitNul(committedNames.stdout),
    ...splitNul(worktreeNames.stdout),
    ...untrackedPaths,
  ]);

  // --raw og --name-only skal beskrive de samme stiene; avvik betyr at noe er galt.
  for (const e of rawEntries) {
    if (!netFiles.has(e.path)) {
      throw new ScopeInspectionError(
        `git diff --raw rapporterte "${e.path}", som mangler i --name-only (inkonsistent output).`
      );
    }
  }

  // Hver commit som pushes, ikke bare nettodiffen: en commit som legger til `.env` og en
  // senere som fjerner den, gir tom nettodiff, men begge havner på remote.
  const perCommit = await inspectCommits(config, wt, baseSha, headSha);
  rawEntries.push(...perCommit.entries);

  const files = [...new Set([...netFiles, ...perCommit.entries.map((e) => e.path)])].sort();

  if (files.length === 0) {
    throw new ScopeInspectionError(
      'Ingen endringer funnet i worktreet — ingenting å sjekke eller pushe.'
    );
  }

  const violations: ScopeViolation[] = [];
  const seen = new Set<string>();
  const add = (v: ScopeViolation): void => {
    const key = `${v.rule}\0${v.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push(v);
    }
  };

  for (const sha of perCommit.merges) {
    add({
      path: sha,
      rule: 'merge_commit',
      reason: `Commit ${sha.slice(0, 12)} er en merge; agentgrenen må være lineær fra basen.`,
    });
  }

  for (const path of files) {
    for (const v of checkPathAgainstScope(path, contract.scope)) add(v);
  }

  for (const e of rawEntries) {
    for (const mode of [e.srcMode, e.dstMode]) {
      if (mode === '120000') {
        add({ path: e.path, rule: 'symlink', reason: `Filsti "${e.path}" er en symlenke.` });
      }
      if (mode === '160000') {
        add({
          path: e.path,
          rule: 'submodule',
          reason: `Filsti "${e.path}" er en submodul (gitlink).`,
        });
      }
    }
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(wt);
  } catch (err) {
    throw new ScopeInspectionError(
      `Fant ikke worktreet ${wt}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  for (const path of untrackedPaths) {
    // `git ls-files --others` viser et innebygd git-repo som "mappe/".
    if (path.endsWith('/')) {
      add({
        path,
        rule: 'submodule',
        reason: `Filsti "${path}" er et innebygd git-repo.`,
      });
      continue;
    }
    if (unsafePathReason(path) !== null) continue; // allerede avvist over
    try {
      if (lstatSync(join(wt, path)).isSymbolicLink()) {
        add({ path, rule: 'symlink', reason: `Filsti "${path}" er en symlenke.` });
      }
    } catch {
      // Finnes ikke lenger: dekkes av realpath-sjekken under.
    }
  }

  for (const path of files) {
    if (unsafePathReason(path) !== null) continue;
    if (escapesWorktree(rootReal, wt, path)) {
      add({
        path,
        rule: 'escapes_worktree',
        reason: `Filsti "${path}" peker ut av worktreet.`,
      });
    }
  }

  if (violations.length > 0) {
    throw new ScopeViolationError(
      `Diffen bryter oppgavens scope (${violations.length} brudd): ${violations
        .slice(0, 10)
        .map((v) => v.reason)
        .join(' | ')}`,
      violations
    );
  }

  return { baseSha, headSha, files };
}
