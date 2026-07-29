import { runCommand } from '../providers/exec.js';
import type { OrchestratorConfig } from '../config.js';
import type { TaskContract, VerifyCommandResult, VerifyResult } from '../types.js';

/**
 * Enkel argv-tokenizer for kommandostrenger fra oppgavekontraktens
 * testRequirements.commands (f.eks. "pnpm run lint"). Støtter enkle og
 * doble anførselstegn for argumenter med mellomrom. Ingen shell-metatgn
 * (`;`, `&&`, `|`, `$()`, osv.) tolkes — de blir bokstavelige argumenter,
 * ikke utført av et shell, siden runCommand alltid spawner argv direkte.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c !== undefined && /\s/.test(c)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Kjører contract.testRequirements.commands i worktreet — steg 7 i
 * arbeidsflyten. Hver kommando går gjennom command-allowlisten (samme
 * sikkerhetslag som all annen kommandokjøring). Kjøres i worktreet, ikke i
 * hovedarbeidskopien, slik at en feilende test aldri kan påvirke reposet
 * utenfor den isolerte grenen.
 */
export async function runVerify(
  config: OrchestratorConfig,
  contract: TaskContract,
  worktreePath: string
): Promise<VerifyResult> {
  const commands: VerifyCommandResult[] = [];
  const perCommandTimeoutMs = Math.max(60_000, contract.constraints.timeoutMinutes * 60_000);

  for (const command of contract.testRequirements.commands) {
    const argv = tokenizeCommand(command);
    if (argv.length === 0) {
      commands.push({
        command,
        exitCode: -1,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: 'Tom kommando etter tokenisering.',
        passed: false,
      });
      continue;
    }

    try {
      const res = await runCommand(argv, {
        cwd: worktreePath,
        repoRoot: worktreePath,
        timeoutMs: perCommandTimeoutMs,
      });
      commands.push({
        command,
        exitCode: res.exitCode ?? -1,
        durationMs: res.durationMs,
        stdoutTail: res.stdout.length > 4000 ? res.stdout.slice(-4000) : res.stdout,
        stderrTail: res.stderr.length > 4000 ? res.stderr.slice(-4000) : res.stderr,
        passed: res.ok,
      });
    } catch (err) {
      commands.push({
        command,
        exitCode: -1,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: err instanceof Error ? err.message : String(err),
        passed: false,
      });
    }
  }

  const passed = !contract.testRequirements.mustPass || commands.every((c) => c.passed);
  return { passed, commands };
}
