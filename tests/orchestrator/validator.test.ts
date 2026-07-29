import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeOutcome } from '../../src/providers/claude.js';

const runClaudeMock = vi.fn<(...args: unknown[]) => Promise<ClaudeOutcome>>();
vi.mock('../../src/providers/claude.js', () => ({
  runClaude: (...args: unknown[]) => runClaudeMock(...args),
}));

const { validatePlan } = await import('../../src/orchestrator/validator.js');

// Midlertidig repo-rot med en reell profilfil — utløser LLM-sjekken via
// AGENT_PROFILE_FILES uten avhengighet til noe eksternt repo.
const profileRepoRoot = mkdtempSync(resolve(tmpdir(), 'validator-profiles-'));
writeFileSync(
  resolve(profileRepoRoot, 'quality-profile.md'),
  '# Kvalitetsprofil\nAll kode skal ha tester.\n',
  'utf8'
);

afterAll(() => {
  rmSync(profileRepoRoot, { recursive: true, force: true });
});

function contract() {
  return {
    id: 'validator-test',
    title: 'x',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['src/**'], disallowedPaths: ['src/secret/**'] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm run lint'], mustPass: true },
    constraints: { maxRetries: 2, timeoutMinutes: 30, allowedImplementers: ['claude' as const] },
    git: { baseBranch: 'main', branchPrefix: 'agent/' },
    metadata: { labels: [] },
  };
}

function fakeConfig() {
  return { repoRoot: '/nonexistent-repo-root-for-tests' } as unknown as Parameters<
    typeof validatePlan
  >[0];
}

describe('validatePlan — statisk sjekk (kjøres alltid, uansett Claude-tilgjengelighet)', () => {
  afterEach(() => {
    runClaudeMock.mockReset();
  });

  it('avviser filer utenfor allowedPaths uten å spørre Claude', async () => {
    const plan = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['other/file.ts'] };
    const result = await validatePlan(fakeConfig(), contract(), plan);
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes('utenfor tillatt scope'))).toBe(true);
    expect(runClaudeMock).not.toHaveBeenCalled();
  });

  it('avviser filer som matcher disallowedPaths', async () => {
    const plan = {
      summary: 'x',
      steps: [],
      risks: [],
      filesExpectedToChange: ['src/secret/key.ts'],
    };
    const result = await validatePlan(fakeConfig(), contract(), plan);
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes('forbudt sti'))).toBe(true);
  });

  it('avviser absolutte stier og path-traversal', async () => {
    const plan1 = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['/etc/passwd'] };
    expect((await validatePlan(fakeConfig(), contract(), plan1)).approved).toBe(false);

    const plan2 = {
      summary: 'x',
      steps: [],
      risks: [],
      filesExpectedToChange: ['src/../../../etc/passwd'],
    };
    expect((await validatePlan(fakeConfig(), contract(), plan2)).approved).toBe(false);
  });

  it('avviser alltid-blokkerte stier (.env, .github/workflows)', async () => {
    const c = contract();
    c.scope.allowedPaths = ['**'];
    const plan = {
      summary: 'x',
      steps: [],
      risks: [],
      filesExpectedToChange: ['.github/workflows/ci.yml'],
    };
    const result = await validatePlan(fakeConfig(), c, plan);
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes('alltid blokkert'))).toBe(true);
  });

  it('tillater .env.example som unntak fra .env-blokkering', async () => {
    const c = contract();
    c.scope.allowedPaths = ['**'];
    const plan = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['.env.example'] };
    runClaudeMock.mockResolvedValue({
      ok: true,
      resultText: '{"approved": true, "reasons": []}',
      costUsd: 0,
      raw: null,
      stderrTail: '',
      timedOut: false,
    });
    const result = await validatePlan(fakeConfig(), c, plan);
    expect(result.reasons.some((r) => r.includes('alltid blokkert'))).toBe(false);
  });

  it('avviser en plan som inneholder noe som ligner en hemmelighet', async () => {
    const plan = {
      summary: 'Sett GITHUB_TOKEN=ghp_' + 'a'.repeat(36),
      steps: [],
      risks: [],
      filesExpectedToChange: ['src/x.ts'],
    };
    const c = contract();
    c.scope.allowedPaths = ['src/**'];
    const result = await validatePlan(fakeConfig(), c, plan);
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes('hemmelighet'))).toBe(true);
  });
});

describe('validatePlan — LLM-sjekk mot profilfiler (AGENT_PROFILE_FILES)', () => {
  afterEach(() => {
    runClaudeMock.mockReset();
    delete process.env.AGENT_PROFILE_FILES;
  });

  it('godtar en gyldig plan når Claude svarer approved: true, og leser konfigurerte profilfiler', async () => {
    process.env.AGENT_PROFILE_FILES = 'quality-profile.md';
    runClaudeMock.mockResolvedValue({
      ok: true,
      resultText: '{"approved": true, "reasons": ["ser bra ut"]}',
      costUsd: 0.01,
      raw: null,
      stderrTail: '',
      timedOut: false,
    });
    const plan = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['src/x.ts'] };
    const result = await validatePlan(
      { repoRoot: profileRepoRoot } as unknown as Parameters<typeof validatePlan>[0],
      contract(),
      plan
    );
    expect(result.approved).toBe(true);
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    const [prompt] = runClaudeMock.mock.calls[0] as [string];
    expect(prompt).toContain('quality-profile.md');
  });

  it('avviser når Claude-kallet feiler', async () => {
    process.env.AGENT_PROFILE_FILES = 'quality-profile.md';
    runClaudeMock.mockResolvedValue({
      ok: false,
      resultText: '',
      costUsd: 0,
      raw: null,
      stderrTail: 'timeout',
      timedOut: true,
    });
    const plan = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['src/x.ts'] };
    const result = await validatePlan(
      { repoRoot: profileRepoRoot } as unknown as Parameters<typeof validatePlan>[0],
      contract(),
      plan
    );
    expect(result.approved).toBe(false);
  });

  it('godkjenner med kun statisk validering når ingen profiler er konfigurert', async () => {
    const plan = { summary: 'x', steps: [], risks: [], filesExpectedToChange: ['src/x.ts'] };
    const result = await validatePlan(
      { repoRoot: profileRepoRoot } as unknown as Parameters<typeof validatePlan>[0],
      contract(),
      plan
    );
    expect(result.approved).toBe(true);
    expect(runClaudeMock).not.toHaveBeenCalled();
  });
});
