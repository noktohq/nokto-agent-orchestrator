import { spawn } from 'node:child_process';
import type { ProviderInvocationResult } from '../types.js';
import {
  assertCommandAllowed,
  type CommandContext,
  type PushPolicy,
} from '../security/allowlist.js';

export interface RunOptions {
  cwd: string;
  repoRoot: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  readOnly?: boolean;
  /** Push-regler (beskyttede grener, grenprefiks) for `git push`. Se PushPolicy. */
  pushPolicy?: PushPolicy;
  /** Skip allowlist-sjekk — brukes kun for provider-binærer (claude/codex) som ikke er git/pnpm/etc. */
  skipAllowlist?: boolean;
}

/**
 * Øvre grense for fanget stdout/stderr per kommando, i byte. Output over grensen kuttes,
 * og `stdoutTruncated`/`stderrTruncated` settes.
 */
export const MAX_CAPTURE_BYTES = 2_000_000;

/**
 * Samler en strøm som Buffer-biter og dekoder én gang til slutt, slik at et flerbyte-tegn
 * som deles over to biter ikke blir U+FFFD. Grensen telles i byte.
 */
class CaptureBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.bytes >= MAX_CAPTURE_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_CAPTURE_BYTES - this.bytes;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.bytes += part.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

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
      ...(opts.pushPolicy !== undefined ? { pushPolicy: opts.pushPolicy } : {}),
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

    const stdout = new CaptureBuffer();
    const stderr = new CaptureBuffer();
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: false,
        exitCode: null,
        stdout: stdout.text(),
        stderr: `${stderr.text()}\n${String(err)}`,
        durationMs: Date.now() - start,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - start,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

export function tail(text: string, maxChars = 4000): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
