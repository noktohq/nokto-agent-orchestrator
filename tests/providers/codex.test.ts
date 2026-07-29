import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInvocationResult } from '../../src/types.js';

const runCommandMock =
  vi.fn<(argv: readonly string[], opts: unknown) => Promise<ProviderInvocationResult>>();

vi.mock('../../src/providers/exec.js', () => ({
  runCommand: (argv: readonly string[], opts: unknown) => runCommandMock(argv, opts),
  tail: (text: string) => text,
}));

const { runCodex } = await import('../../src/providers/codex.js');

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

describe('runCodex', () => {
  afterEach(() => {
    runCommandMock.mockReset();
  });

  it('bygger argv med -a never (aldri --full-auto/--yolo/danger-full-access)', async () => {
    runCommandMock.mockImplementation(async (argv: readonly string[]) => {
      const outIdx = argv.indexOf('-o');
      const outputFile = argv[outIdx + 1] as string;
      writeFileSync(outputFile, 'ferdig implementert', 'utf8');
      return { ok: true, exitCode: 0, stdout: '{}', stderr: '', durationMs: 5, timedOut: false };
    });

    const res = await runCodex('gjør noe', fakeConfig(), {
      cwd: '/repo/.worktrees/t-1',
      repoRoot: '/repo',
      sandboxOverride: 'workspace-write',
    });

    expect(res.ok).toBe(true);
    expect(res.finalMessage).toBe('ferdig implementert');

    const [argv] = runCommandMock.mock.calls[0] as [string[], unknown];
    expect(argv).toContain('-a');
    expect(argv[argv.indexOf('-a') + 1]).toBe('never');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('danger-full-access');
    expect(argv).toContain('-s');
    expect(argv[argv.indexOf('-s') + 1]).toBe('workspace-write');
  });

  it('bruker read-only sandbox for gjennomgangsoppgaver når overstyrt', async () => {
    runCommandMock.mockImplementation(async (argv: readonly string[]) => {
      const outIdx = argv.indexOf('-o');
      writeFileSync(argv[outIdx + 1] as string, '{"approved": true, "findings": []}', 'utf8');
      return { ok: true, exitCode: 0, stdout: '{}', stderr: '', durationMs: 5, timedOut: false };
    });

    await runCodex('se over diffen', fakeConfig(), {
      cwd: '/repo/.worktrees/t-1',
      repoRoot: '/repo',
      sandboxOverride: 'read-only',
    });

    const [argv] = runCommandMock.mock.calls[0] as [string[], unknown];
    expect(argv[argv.indexOf('-s') + 1]).toBe('read-only');
  });

  it('later aldri som suksess dersom kommandoen feiler eller time out', async () => {
    runCommandMock.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'codex: noe gikk galt',
      durationMs: 5,
      timedOut: false,
    });
    const res = await runCodex('gjør noe', fakeConfig(), {
      cwd: '/repo/.worktrees/t-1',
      repoRoot: '/repo',
    });
    expect(res.ok).toBe(false);
  });

  it('returnerer tom finalMessage (ikke krasj) dersom outputfilen aldri ble skrevet', async () => {
    runCommandMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 5,
      timedOut: false,
    });
    const res = await runCodex('gjør noe', fakeConfig(), {
      cwd: '/repo/.worktrees/t-1',
      repoRoot: '/repo',
    });
    expect(res.ok).toBe(true);
    expect(res.finalMessage).toBe('');
  });
});
