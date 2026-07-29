import { spawn } from 'node:child_process';
import type { ProviderInvocationResult } from '../types.js';
import { assertCommandAllowed, type CommandContext } from '../security/allowlist.js';

export interface RunOptions {
  cwd: string;
  repoRoot: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  readOnly?: boolean;
  /** Skip allowlist-sjekk — brukes kun for provider-binærer (claude/codex) som ikke er git/pnpm/etc. */
  skipAllowlist?: boolean;
}

const MAX_CAPTURE_BYTES = 2_000_000;

/**
 * Trygg prosess-spawn. Kjører alltid som argv-array (aldri shell:true), håndhever
 * allowlist for interne kommandoer, og har en hard timeout med SIGKILL-eskalering
 * dersom SIGTERM ikke avslutter prosessen.
 */
export async function runCommand(
  argv: readonly string[],
  opts: RunOptions
): Promise<ProviderInvocationResult> {
  if (!opts.skipAllowlist) {
    const ctx: CommandContext = {
      cwd: opts.cwd,
      repoRoot: opts.repoRoot,
      ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    };
    assertCommandAllowed(argv, ctx);
  }

  const [bin, ...args] = argv;
  if (!bin) throw new Error('Tom kommando.');

  const start = Date.now();

  return new Promise<ProviderInvocationResult>((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
    });

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${String(err)}`,
        durationMs: Date.now() - start,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export function tail(text: string, maxChars = 4000): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
