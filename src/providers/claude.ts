import { runCommand, tail } from './exec.js';
import type { OrchestratorConfig } from '../config.js';

/**
 * Claude-provider — bruker den ekte, installerte `claude` CLI-en (aldri en
 * simulert/antatt kommando). Flagg er verifisert mot `claude --help` og mot
 * faktiske testkjøringer av `claude -p ... --output-format json`:
 *
 *   claude -p "<prompt>" --output-format json --permission-mode <mode>
 *          [--model <navn>] [--max-budget-usd <n>] [--add-dir <dir>]
 *
 * JSON-resultatet er verifisert empirisk til å inneholde minst:
 *   type: "result", subtype: string, is_error: boolean,
 *   result?: string, total_cost_usd: number, session_id: string,
 *   duration_ms: number, errors?: string[]
 *
 * Ingen modellnavn er hardkodet — --model utelates helt med mindre
 * AGENT_CLAUDE_MODEL er satt, slik at leverandørens egen standardmodell
 * brukes.
 */
export interface ClaudeResultJson {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  duration_ms?: number;
  errors?: string[];
}

export type ClaudePermissionMode =
  'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk';

export interface RunClaudeOptions {
  cwd: string;
  repoRoot: string;
  permissionMode: ClaudePermissionMode;
  addDir?: string;
  systemPromptAppend?: string;
  allowedTools?: string[];
}

export interface ClaudeOutcome {
  ok: boolean;
  resultText: string;
  costUsd: number;
  raw: ClaudeResultJson | null;
  stderrTail: string;
  timedOut: boolean;
}

export async function runClaude(
  prompt: string,
  config: OrchestratorConfig,
  opts: RunClaudeOptions
): Promise<ClaudeOutcome> {
  const argv: string[] = [
    config.claudeBin,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--permission-mode',
    opts.permissionMode,
  ];

  if (config.claudeModel) argv.push('--model', config.claudeModel);
  if (config.claudeMaxBudgetUsd !== undefined)
    argv.push('--max-budget-usd', String(config.claudeMaxBudgetUsd));
  if (opts.addDir) argv.push('--add-dir', opts.addDir);
  if (opts.systemPromptAppend) argv.push('--append-system-prompt', opts.systemPromptAppend);
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    argv.push('--allowedTools', ...opts.allowedTools);
  }

  const res = await runCommand(argv, {
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
    timeoutMs: config.claudeTimeoutSec * 1000,
    skipAllowlist: true,
  });

  let parsed: ClaudeResultJson | null = null;
  try {
    parsed = JSON.parse(res.stdout) as ClaudeResultJson;
  } catch {
    parsed = null;
  }

  // Et vellykket exit-kode med ikke-parserbar JSON er IKKE suksess — det betyr at vi
  // ikke kan stole på resultatet. Later aldri som suksess i et slikt tilfelle.
  return {
    ok: res.ok && parsed !== null && parsed.is_error !== true,
    resultText: parsed?.result ?? '',
    costUsd: parsed?.total_cost_usd ?? 0,
    raw: parsed,
    stderrTail: tail(res.stderr),
    timedOut: res.timedOut,
  };
}
