import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

export class ConfigError extends Error {}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`Ugyldig miljøvariabel ${name}="${raw}" — må være et positivt heltall`);
  }
  return n;
}

function floatEnvOptional(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`Ugyldig miljøvariabel ${name}="${raw}" — må være et positivt tall`);
  }
  return n;
}

const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandboxMode = (typeof SANDBOX_MODES)[number];

function sandboxEnv(name: string, fallback: CodexSandboxMode): CodexSandboxMode {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `Ugyldig miljøvariabel ${name}="${raw}" — må være en av: ${SANDBOX_MODES.join(', ')}`
    );
  }
  if (raw === 'danger-full-access') {
    throw new ConfigError(
      `${name}=danger-full-access er blokkert. Orkestratoren tillater aldri full filsystemtilgang for implementeringsagenten.`
    );
  }
  return raw as CodexSandboxMode;
}

export interface OrchestratorConfig {
  repoRoot: string;
  stateDir: string;
  auditDir: string;
  worktreeDir: string;

  claudeBin: string;
  claudeModel: string | undefined;
  claudeMaxBudgetUsd: number | undefined;
  claudeTimeoutSec: number;

  codexBin: string;
  codexModel: string | undefined;
  codexSandbox: CodexSandboxMode;
  codexTimeoutSec: number;

  geminiApiKey: string | undefined;
  geminiModel: string;
  geminiTimeoutSec: number;

  githubToken: string | undefined;
  githubApiBase: string;
  githubOwner: string | undefined;
  githubRepo: string | undefined;
}

let cached: OrchestratorConfig | null = null;

/**
 * Laster og validerer konfigurasjon fra miljøvariabler.
 * Kaster ConfigError ved ugyldig verdi — kaller må stoppe prosessen.
 * Ingen modellnavn er hardkodet: AGENT_CLAUDE_MODEL / AGENT_CODEX_MODEL er
 * valgfrie. Utelates de, brukes leverandørens eget standardvalg. Unntaket er
 * Gemini: API-et krever et eksplisitt modellnavn per kall, så GEMINI_MODEL har
 * en dokumentert standardverdi som kan overstyres (eksakte modellnavn endres
 * over tid).
 */
export function loadConfig(): OrchestratorConfig {
  if (cached) return cached;

  const repoRoot = optionalEnv('AGENT_ORCH_REPO_ROOT') ?? PKG_ROOT;
  if (!existsSync(resolve(repoRoot, '.git'))) {
    throw new ConfigError(
      `AGENT_ORCH_REPO_ROOT (${repoRoot}) er ikke roten av et git-repo (.git mangler)`
    );
  }

  const stateDir = optionalEnv('AGENT_ORCH_STATE_DIR') ?? resolve(PKG_ROOT, '.state');
  const auditDir = optionalEnv('AGENT_ORCH_AUDIT_DIR') ?? resolve(PKG_ROOT, 'audit');
  const worktreeDir = optionalEnv('AGENT_ORCH_WORKTREE_DIR') ?? resolve(PKG_ROOT, '.worktrees');

  for (const dir of [stateDir, auditDir, worktreeDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const config: OrchestratorConfig = {
    repoRoot,
    stateDir,
    auditDir,
    worktreeDir,

    claudeBin: optionalEnv('AGENT_CLAUDE_BIN') ?? 'claude',
    claudeModel: optionalEnv('AGENT_CLAUDE_MODEL'),
    claudeMaxBudgetUsd: floatEnvOptional('AGENT_CLAUDE_MAX_BUDGET_USD'),
    claudeTimeoutSec: intEnv('AGENT_CLAUDE_TIMEOUT_SEC', 900),

    codexBin: optionalEnv('AGENT_CODEX_BIN') ?? 'codex',
    codexModel: optionalEnv('AGENT_CODEX_MODEL'),
    codexSandbox: sandboxEnv('AGENT_CODEX_SANDBOX', 'workspace-write'),
    codexTimeoutSec: intEnv('AGENT_CODEX_TIMEOUT_SEC', 1800),

    geminiApiKey: optionalEnv('GEMINI_API_KEY'),
    geminiModel: optionalEnv('GEMINI_MODEL') ?? 'gemini-3.5-flash',
    geminiTimeoutSec: intEnv('AGENT_GEMINI_TIMEOUT_SEC', 600),

    githubToken: optionalEnv('GITHUB_TOKEN'),
    githubApiBase: optionalEnv('GITHUB_API_BASE') ?? 'https://api.github.com',
    githubOwner: optionalEnv('GITHUB_REPO_OWNER'),
    githubRepo: optionalEnv('GITHUB_REPO_NAME'),
  };

  cached = config;
  return config;
}

/** Kun for tester — nullstiller cachet config slik at env-endringer plukkes opp på nytt. */
export function resetConfigCache(): void {
  cached = null;
}
