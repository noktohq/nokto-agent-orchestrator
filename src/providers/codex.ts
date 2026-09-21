import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runCommand, tail } from './exec.js';
import type { OrchestratorConfig } from '../config.js';

/**
 * Codex-provider — spawner den ekte `codex` CLI-en når den er installert.
 * Flagg er empirisk verifisert mot codex-cli 0.144.6:
 *
 *   codex exec "<prompt>" -C <worktree> -s <read-only|workspace-write>
 *              [-m <model>] --json -o <output-file>
 *
 * `codex exec` er alltid non-interactive i codex-cli ≥0.144 og godtar ikke
 * lenger `-a/--ask-for-approval` (gir "unexpected argument '-a'").
 * Kommandofeil returneres direkte til modellen.
 * `--dangerously-bypass-approvals-and-sandbox`/`--yolo` og
 * `-s danger-full-access` brukes ALDRI av denne adapteren — eksplisitt
 * ekskludert som en sikkerhetsgrense (se også config.ts: sandboxEnv()).
 */
export interface RunCodexOptions {
  cwd: string;
  repoRoot: string;
  /** Overstyrer config.codexSandbox — bruk "read-only" for review-/analyseoppgaver. */
  sandboxOverride?: 'read-only' | 'workspace-write';
}

export interface CodexOutcome {
  ok: boolean;
  finalMessage: string;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  exitCode: number | null;
}

export async function runCodex(
  prompt: string,
  config: OrchestratorConfig,
  opts: RunCodexOptions
): Promise<CodexOutcome> {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'nokto-agent-codex-'));
  const outputFile = resolve(tmpDir, 'final-message.txt');

  try {
    const sandbox = opts.sandboxOverride ?? config.codexSandbox;
    const argv: string[] = [
      config.codexBin,
      'exec',
      prompt,
      '-C',
      opts.cwd,
      '-s',
      sandbox,
      '--json',
      '-o',
      outputFile,
    ];
    if (config.codexModel) argv.push('-m', config.codexModel);

    const res = await runCommand(argv, {
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      timeoutMs: config.codexTimeoutSec * 1000,
      skipAllowlist: true,
    });

    let finalMessage = '';
    try {
      finalMessage = readFileSync(outputFile, 'utf8').trim();
    } catch {
      finalMessage = '';
    }

    return {
      ok: res.ok && !res.timedOut,
      finalMessage,
      stdoutTail: tail(res.stdout),
      stderrTail: tail(res.stderr),
      timedOut: res.timedOut,
      exitCode: res.exitCode,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
