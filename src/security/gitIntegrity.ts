import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { runCommand } from '../providers/exec.js';
import type { OrchestratorConfig } from '../config.js';

/**
 * Vern mot at implementereren påvirker orkestratorens egne git-kall.
 *
 * Refs, objekter og `.git/config` deles mellom alle worktrees i et repo, og agenten
 * kjører som samme OS-bruker som orkestratoren. Alt agenten kan skrive der, kan endre
 * hva orkestratorens `git fetch`, `git diff` og `git push` gjør. Denne modulen samler
 * mottiltakene:
 *
 * - `GIT_SAFETY_ARGS`: hooks og fsmonitor av for alle orkestrator-git-kall.
 * - `inspectionGitEnv()`: miljø for rene lesekall (scope-vakt, diff til review og
 *   hemmelighetsskanning) — ingen replace-objekter, ingen system-/global konfig, ingen
 *   arvede `GIT_*`-variabler.
 * - `fetchBaseSha()`: basen leses fra remote med en refspec orkestratoren eier, ikke
 *   fra `origin/<gren>`, som agenten kan flytte eller frakoble fra fetch.
 * - `gitConfigDigest()`: fingeravtrykk av git-konfigurasjonen som tas før agenten
 *   kjører og sjekkes før hvert nytt forsøk og før push.
 */

/** Integriteten til repoet eller remote-basen kan ikke bekreftes. Oppgaven skal feile. */
export class GitIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitIntegrityError';
  }
}

/** Globale `-c`-opsjoner for alle git-kall orkestratoren selv gjør. */
export const GIT_SAFETY_ARGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Gyldig grennavn uten git-spesialsyntaks. Brukes før navnet settes inn i en refspec. */
const SAFE_REF_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isSafeBranchName(name: string): boolean {
  return (
    SAFE_REF_COMPONENT_RE.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.split('/').some((seg) => seg.startsWith('.'))
  );
}

/** Arvede variabler som kan flytte git til et annet repo eller injisere konfig/kommandoer. */
function withoutGitVariables(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Miljø for git-kall som bare leser (scope-vakt, diff til review og skanning):
 * `GIT_NO_REPLACE_OBJECTS` gjør at `refs/replace/*` ikke kan vise et annet tre enn det
 * som pushes, og system-/global konfig (som agenten kan skrive i `~/.gitconfig`) leses ikke.
 */
export function inspectionGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutGitVariables(base),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Miljø for git-kall som snakker med remote (fetch, push). Global konfig beholdes, fordi
 * legitimasjonen ofte ligger der (f.eks. `gh auth setup-git`); den er dekket av
 * `gitConfigDigest()`. Replace-objekter er av og ingen arvede `GIT_*`-variabler.
 */
export function remoteGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutGitVariables(base),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Hemmeligheter og variabler som aldri skal arves av implementereren eller av
 * verifiseringskommandoene (som kjører `package.json`-scripts agenten kan ha skrevet).
 * Leverandørnøklene agenten selv trenger (Anthropic/OpenAI) beholdes.
 */
const AGENT_ENV_DENYLIST = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
]);

export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (AGENT_ENV_DENYLIST.has(k)) continue;
    if (k.startsWith('GIT_')) continue;
    if (/^GITHUB_.*TOKEN/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function gitOut(
  config: OrchestratorConfig,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000
): Promise<string> {
  const res = await runCommand(['git', ...GIT_SAFETY_ARGS, ...args], {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    timeoutMs,
    readOnly: true,
    env,
  });
  if (!res.ok) {
    throw new GitIntegrityError(
      `git ${args[0] ?? ''} feilet (exit ${res.exitCode ?? 'n/a'}): ${res.stderr.trim().slice(0, 300)}`
    );
  }
  return res.stdout;
}

/** Repoets felles git-katalog (delt mellom alle worktrees), som absolutt sti. */
export async function gitCommonDir(config: OrchestratorConfig): Promise<string> {
  const out = (await gitOut(config, ['rev-parse', '--git-common-dir'], inspectionGitEnv())).trim();
  if (out === '') throw new GitIntegrityError('Fant ikke repoets git-katalog.');
  return isAbsolute(out) ? out : resolve(config.repoRoot, out);
}

function globalConfigFiles(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  const xdg = env.XDG_CONFIG_HOME ?? resolve(home, '.config');
  return [resolve(home, '.gitconfig'), resolve(xdg, 'git', 'config')];
}

/**
 * Fingeravtrykk av git-konfigurasjonen som påvirker orkestratorens git-kall: repoets
 * felles `config` og brukerens globale konfig. Agenten kan endre
 * `remote.origin.{url,pushurl,fetch,push}`, `url.*.insteadOf`, `credential.helper`,
 * `core.sshCommand`, `http.*` og `filter.*` der; endres noe av det mellom to sjekker,
 * stopper oppgaven.
 */
export async function gitConfigDigest(config: OrchestratorConfig): Promise<string> {
  const common = await gitCommonDir(config);
  const files = [resolve(common, 'config'), resolve(common, 'config.worktree')];
  files.push(...globalConfigFiles(process.env));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    if (existsSync(file)) {
      hash.update(readFileSync(file));
    } else {
      hash.update('<mangler>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Kaster GitIntegrityError dersom git-konfigurasjonen er endret siden `expected` ble tatt. */
export async function assertGitConfigUnchanged(
  config: OrchestratorConfig,
  expected: string
): Promise<void> {
  const now = await gitConfigDigest(config);
  if (now !== expected) {
    throw new GitIntegrityError(
      'Git-konfigurasjonen (repoets .git/config eller global konfig) er endret mens oppgaven kjørte. ' +
        'Orkestratoren kjører ikke fetch/push med konfig agenten kan ha endret.'
    );
  }
}

/**
 * Henter `refs/heads/<baseBranch>` fra origin til en ref orkestratoren eier
 * (`refs/nokto/<kind>/<taskId>`) og returnerer commit-id-en. Den eksplisitte
 * refspec-en gjør at `remote.origin.fetch` og `refs/remotes/origin/*` — som agenten kan
 * endre — ikke påvirker resultatet.
 */
export async function fetchBaseSha(
  config: OrchestratorConfig,
  taskId: string,
  baseBranch: string,
  kind: 'base' | 'remote-base' = 'base'
): Promise<string> {
  if (!isSafeBranchName(baseBranch)) {
    throw new GitIntegrityError(`Ugyldig baseBranch "${baseBranch}".`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskId)) {
    throw new GitIntegrityError(`Ugyldig oppgave-id "${taskId}".`);
  }
  const ownRef = `refs/nokto/${kind}/${taskId}`;
  await gitOut(
    config,
    [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      'origin',
      `+refs/heads/${baseBranch}:${ownRef}`,
    ],
    remoteGitEnv(),
    60_000
  );
  const sha = (
    await gitOut(
      config,
      ['rev-parse', '--verify', '--end-of-options', `${ownRef}^{commit}`],
      inspectionGitEnv()
    )
  ).trim();
  if (!SHA_RE.test(sha)) {
    throw new GitIntegrityError(`Fant ikke commit for origin/${baseBranch}.`);
  }
  return sha;
}

/** Bekrefter at `sha` finnes lokalt som commit. */
export async function assertCommitExists(config: OrchestratorConfig, sha: string): Promise<void> {
  if (!SHA_RE.test(sha)) throw new GitIntegrityError('Ugyldig commit-id for basen.');
  const out = (
    await gitOut(
      config,
      ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
      inspectionGitEnv()
    )
  ).trim();
  if (out !== sha) throw new GitIntegrityError(`Base-commiten ${sha.slice(0, 12)} finnes ikke.`);
}

/**
 * Før push: basen scope-vakten differ mot må finnes i remote-grenens historikk. Da er
 * alt som kan nås fra basen allerede på remote, og pushen tar bare med commits i
 * `base..HEAD` — de vakten har sjekket. Kaster GitIntegrityError ellers.
 */
export async function assertBaseOnRemote(
  config: OrchestratorConfig,
  taskId: string,
  baseBranch: string,
  baseSha: string
): Promise<string> {
  const remoteSha = await fetchBaseSha(config, taskId, baseBranch, 'remote-base');
  const res = await runCommand(
    ['git', ...GIT_SAFETY_ARGS, 'merge-base', '--is-ancestor', baseSha, remoteSha],
    {
      cwd: config.repoRoot,
      repoRoot: config.repoRoot,
      timeoutMs: 30_000,
      readOnly: true,
      env: inspectionGitEnv(),
    }
  );
  if (res.exitCode === 1 && !res.timedOut) {
    throw new GitIntegrityError(
      `Base-commiten ${baseSha.slice(0, 12)} finnes ikke i origin/${baseBranch} (${remoteSha.slice(0, 12)}). Push stoppet.`
    );
  }
  if (!res.ok) {
    throw new GitIntegrityError(
      `git merge-base --is-ancestor feilet: ${res.stderr.trim().slice(0, 300)}`
    );
  }
  return remoteSha;
}
