import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/providers/detect.js';
import { runClaude } from '../../src/providers/claude.js';
import type { OrchestratorConfig } from '../../src/config.js';

/**
 * Ekte integrasjonstester mot faktisk installerte claude/codex-CLI-er.
 * runDoctor() kjøres alltid (gratis, rask, ingen risiko) og verifiserer at
 * doctor-sjekken faktisk reflekterer miljøet — den gjetter aldri.
 *
 * Det ene ekte, betalte kallet til `claude -p` er bak et eksplisitt opt-in
 * (RUN_LIVE_PROVIDER_TESTS=1) slik at vanlig `pnpm test`/CI ALDRI påfører
 * reell API-kostnad eller krever at claude/codex faktisk er installert.
 * Sett variabelen lokalt for å faktisk øve på et ekte kall.
 */
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function testConfig(): OrchestratorConfig {
  return {
    repoRoot,
    stateDir: resolve(repoRoot, '.state'),
    auditDir: resolve(repoRoot, 'audit'),
    worktreeDir: resolve(repoRoot, '.worktrees'),
    claudeBin: 'claude',
    claudeModel: undefined,
    claudeMaxBudgetUsd: undefined,
    claudeTimeoutSec: 120,
    codexBin: 'codex',
    codexModel: undefined,
    codexSandbox: 'workspace-write',
    codexTimeoutSec: 120,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: 'gemini-3.5-flash',
    geminiTimeoutSec: 120,
    githubToken: undefined,
    githubApiBase: 'https://api.github.com',
    githubOwner: undefined,
    githubRepo: undefined,
  };
}

describe('runDoctor (ekte probe, ingen mocking)', () => {
  it('rapporterer faktisk tilgjengelighet uten å simulere', async () => {
    const report = await runDoctor(testConfig());
    expect(report).toHaveLength(4);
    for (const r of report) {
      expect(['claude', 'codex', 'gemini', 'github']).toContain(r.provider);
      expect(typeof r.available).toBe('boolean');
      expect(typeof r.detail).toBe('string');
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it('gemini-rapporten reflekterer GEMINI_API_KEY uten å lekke nøkkelverdien', async () => {
    const report = await runDoctor(testConfig());
    const gemini = report.find((r) => r.provider === 'gemini');
    expect(gemini?.available).toBe(process.env.GEMINI_API_KEY !== undefined);
    if (process.env.GEMINI_API_KEY) {
      expect(gemini?.detail).not.toContain(process.env.GEMINI_API_KEY);
    }
  });
});

describe.skipIf(process.env.RUN_LIVE_PROVIDER_TESTS !== '1')(
  'ekte claude -p-kall (opt-in, koster penger)',
  () => {
    it('svarer med et gyldig JSON-resultat på et minimalt prompt', async () => {
      const outcome = await runClaude('Svar med kun ordet: OK', testConfig(), {
        cwd: repoRoot,
        repoRoot,
        permissionMode: 'plan',
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.resultText.length).toBeGreaterThan(0);
    }, 120_000);
  }
);
