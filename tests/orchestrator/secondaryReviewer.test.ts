import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorConfig } from '../../src/config.js';
import type { ReviewResult, TaskContract } from '../../src/types.js';

vi.mock('../../src/providers/detect.js', () => ({ runDoctor: vi.fn() }));

const { runDoctor } = await import('../../src/providers/detect.js');
const { needsSecondaryReview, secondaryReviewCode } =
  await import('../../src/orchestrator/secondaryReviewer.js');

function review(findings: ReviewResult['findings']): ReviewResult {
  return { reviewer: 'claude', approved: true, findings, raw: '' };
}

describe('needsSecondaryReview', () => {
  it('trigges alltid når Claude var implementerende agent', () => {
    expect(needsSecondaryReview('claude', review([]))).toBe(true);
  });

  it('trigges når Codex implementerte og primærgjennomgangen fant et "major"-funn', () => {
    expect(
      needsSecondaryReview('codex', review([{ severity: 'major', file: null, summary: 'x' }]))
    ).toBe(true);
  });

  it('trigges IKKE når Codex implementerte og ingen major/blocker-funn finnes', () => {
    expect(
      needsSecondaryReview('codex', review([{ severity: 'minor', file: null, summary: 'x' }]))
    ).toBe(false);
    expect(needsSecondaryReview('codex', review([]))).toBe(false);
  });
});

describe('secondaryReviewCode — leverandørvalg', () => {
  afterEach(() => {
    vi.mocked(runDoctor).mockReset();
  });

  function contract(): TaskContract {
    return {
      id: 'secondary-test',
      title: 'x',
      goal: 'x',
      scope: { description: 'x', allowedPaths: ['a/**'], disallowedPaths: [] },
      acceptanceCriteria: ['x'],
      testRequirements: { commands: ['pnpm run lint'], mustPass: true },
      constraints: {
        maxRetries: 0,
        timeoutMinutes: 10,
        allowedImplementers: ['claude'],
        reviewers: ['claude', 'gemini'],
        secondaryReviewers: ['codex', 'gemini'],
      },
      git: { baseBranch: 'main', branchPrefix: 'agent/' },
      metadata: { labels: [] },
    };
  }

  function fakeConfig(): OrchestratorConfig {
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
      codexSandbox: 'workspace-write',
      codexTimeoutSec: 1800,
      geminiApiKey: undefined,
      geminiModel: 'gemini-3.5-flash',
      geminiTimeoutSec: 600,
      githubToken: undefined,
      githubApiBase: 'https://api.github.com',
      githubOwner: undefined,
      githubRepo: undefined,
    };
  }

  const plan = { summary: 'plan', steps: [], risks: [], filesExpectedToChange: ['a/x.ts'] };

  it('returnerer null (aldri en falsk godkjenning) når ingen sekundær leverandør er tilgjengelig', async () => {
    vi.mocked(runDoctor).mockResolvedValue([
      { provider: 'claude', available: true, version: '1.0.0', detail: 'ok' },
      { provider: 'codex', available: false, version: null, detail: 'ikke installert' },
      {
        provider: 'gemini',
        available: false,
        version: null,
        detail: 'GEMINI_API_KEY er ikke satt',
      },
      { provider: 'github', available: false, version: null, detail: 'ingen token' },
    ]);

    const result = await secondaryReviewCode(fakeConfig(), contract(), plan, '/repo/.worktrees/x');
    expect(result).toBeNull();
  });
});
