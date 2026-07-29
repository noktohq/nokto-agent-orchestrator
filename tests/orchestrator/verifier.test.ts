import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerify, tokenizeCommand } from '../../src/orchestrator/verifier.js';
import type { TaskContract } from '../../src/types.js';

describe('tokenizeCommand', () => {
  it('splitter enkle kommandoer på mellomrom', () => {
    expect(tokenizeCommand('pnpm run lint')).toEqual(['pnpm', 'run', 'lint']);
  });

  it('respekterer doble og enkle anførselstegn', () => {
    expect(tokenizeCommand('node -e "console.log(1)"')).toEqual(['node', '-e', 'console.log(1)']);
    expect(tokenizeCommand("git commit -m 'en melding med mellomrom'")).toEqual([
      'git',
      'commit',
      '-m',
      'en melding med mellomrom',
    ]);
  });

  it('håndterer flere mellomrom uten tomme tokens', () => {
    expect(tokenizeCommand('pnpm   run    lint')).toEqual(['pnpm', 'run', 'lint']);
  });

  it('returnerer tom liste for tom streng', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([]);
  });
});

function baseContract(commands: string[]): TaskContract {
  return {
    id: 'verify-test',
    title: 'Verify test',
    goal: 'Test',
    scope: { description: 'x', allowedPaths: ['**'], disallowedPaths: [] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands, mustPass: true },
    constraints: { maxRetries: 0, timeoutMinutes: 1, allowedImplementers: ['claude'] },
    git: { baseBranch: 'main', branchPrefix: 'agent/' },
    metadata: { labels: [] },
  };
}

describe('runVerify (ekte kommandokjøring)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'nokto-verify-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = {
    repoRoot: '',
    stateDir: '',
    auditDir: '',
    worktreeDir: '',
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
  };

  it('rapporterer passed=true når alle kommandoer lykkes', async () => {
    const result = await runVerify(config, baseContract(['git status']), dir);
    expect(result.passed).toBe(true);
    expect(result.commands[0]?.passed).toBe(true);
  });

  it('rapporterer passed=false når en kommando feiler', async () => {
    const result = await runVerify(config, baseContract(['node -e "process.exit(1)"']), dir);
    expect(result.passed).toBe(false);
    expect(result.commands[0]?.passed).toBe(false);
    expect(result.commands[0]?.exitCode).toBe(1);
  });

  it('mustPass=false gir passed=true selv om en kommando feiler', async () => {
    const contract = baseContract(['node -e "process.exit(1)"']);
    contract.testRequirements.mustPass = false;
    const result = await runVerify(config, contract, dir);
    expect(result.passed).toBe(true);
    expect(result.commands[0]?.passed).toBe(false);
  });

  it('blokkerer kommandoer som ikke er på allowlisten i stedet for å kjøre dem', async () => {
    const result = await runVerify(config, baseContract(['rm -rf /tmp/whatever']), dir);
    expect(result.passed).toBe(false);
    expect(result.commands[0]?.passed).toBe(false);
    expect(result.commands[0]?.stderrTail).toContain('ikke på allowlisten');
  });
});
