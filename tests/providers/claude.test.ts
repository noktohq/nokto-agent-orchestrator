import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInvocationResult } from '../../src/types.js';

const runCommandMock =
  vi.fn<(argv: readonly string[], opts: unknown) => Promise<ProviderInvocationResult>>();

vi.mock('../../src/providers/exec.js', () => ({
  runCommand: (argv: readonly string[], opts: unknown) => runCommandMock(argv, opts),
  tail: (text: string) => text,
}));

const { runClaude } = await import('../../src/providers/claude.js');

function fakeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    repoRoot: '/repo',
    stateDir: '/repo/.state',
    auditDir: '/repo/audit',
    worktreeDir: '/repo/.worktrees',
    claudeBin: 'claude',
    claudeModel: undefined,
    claudeMaxBudgetUsd: undefined,
    claudeTimeoutSec: 900,
    codexBin: 'codex',
    codexModel: undefined,
    codexSandbox: 'workspace-write' as const,
    codexTimeoutSec: 1800,
    githubToken: undefined,
    githubApiBase: 'https://api.github.com',
    githubOwner: undefined,
    githubRepo: undefined,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('runClaude', () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it('bygger korrekt argv og parser ekte JSON-resultatform', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ferdig',
        total_cost_usd: 0.05,
        session_id: 'abc',
        duration_ms: 1200,
      }),
      stderr: '',
      durationMs: 1200,
      timedOut: false,
    });

    const outcome = await runClaude('hei', fakeConfig(), {
      cwd: '/repo',
      repoRoot: '/repo',
      permissionMode: 'plan',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.resultText).toBe('ferdig');
    expect(outcome.costUsd).toBe(0.05);

    const [argv] = runCommandMock.mock.calls[0] as [string[], unknown];
    expect(argv).toEqual([
      'claude',
      '-p',
      'hei',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
    ]);
  });

  it('hardkoder aldri modellnavn — utelater --model uten AGENT_CLAUDE_MODEL', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
      stderr: '',
      durationMs: 10,
      timedOut: false,
    });
    await runClaude('hei', fakeConfig({ claudeModel: undefined }), {
      cwd: '/repo',
      repoRoot: '/repo',
      permissionMode: 'plan',
    });
    const [argv] = runCommandMock.mock.calls[0] as [string[], unknown];
    expect(argv).not.toContain('--model');
  });

  it('inkluderer --model kun når AGENT_CLAUDE_MODEL er satt', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
      stderr: '',
      durationMs: 10,
      timedOut: false,
    });
    await runClaude('hei', fakeConfig({ claudeModel: 'claude-sonnet-5' }), {
      cwd: '/repo',
      repoRoot: '/repo',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Edit'],
    });
    const [argv] = runCommandMock.mock.calls[0] as [string[], unknown];
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-5');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Read');
  });

  it('markerer ok=false når is_error er true, selv om exit-kode er 0', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        errors: ['noe gikk galt'],
      }),
      stderr: '',
      durationMs: 10,
      timedOut: false,
    });
    const outcome = await runClaude('hei', fakeConfig(), {
      cwd: '/repo',
      repoRoot: '/repo',
      permissionMode: 'plan',
    });
    expect(outcome.ok).toBe(false);
  });

  it('håndterer ugyldig JSON uten å kaste', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: 'ikke json i det hele tatt',
      stderr: '',
      durationMs: 10,
      timedOut: false,
    });
    const outcome = await runClaude('hei', fakeConfig(), {
      cwd: '/repo',
      repoRoot: '/repo',
      permissionMode: 'plan',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.resultText).toBe('');
  });
});
