import { describe, expect, it } from 'vitest';
import {
  parseReviewResult,
  pickReviewer,
  reviewHasBlockers,
} from '../../src/orchestrator/reviewer.js';
import type { ProviderName } from '../../src/types.js';

describe('parseReviewResult', () => {
  it('parser gyldig JSON', () => {
    const result = parseReviewResult(
      'claude',
      'Her er vurderingen:\n{"approved": true, "findings": [{"severity": "minor", "file": "a.ts", "summary": "ok"}]}'
    );
    expect(result.approved).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.reviewer).toBe('claude');
  });

  it('parser rene JSON-svar fra Gemini (responseMimeType application/json)', () => {
    const result = parseReviewResult('gemini', '{"approved": false, "findings": []}');
    expect(result.approved).toBe(false);
    expect(result.reviewer).toBe('gemini');
  });

  it('avviser (approved: false) når det ikke finnes gyldig JSON', () => {
    const result = parseReviewResult('codex', 'jeg klarte ikke å gjennomgå dette');
    expect(result.approved).toBe(false);
    expect(result.findings[0]?.severity).toBe('blocker');
  });

  it('avviser når JSON mangler påkrevde felt', () => {
    const result = parseReviewResult('claude', '{"foo": "bar"}');
    expect(result.approved).toBe(false);
  });
});

describe('pickReviewer', () => {
  const available = (...names: ProviderName[]) => new Set<ProviderName>(names);

  it('velger første tilgjengelige leverandør i prioritert rekkefølge', () => {
    expect(pickReviewer(['claude', 'gemini'] as const, available('claude', 'gemini'))).toBe(
      'claude'
    );
    expect(pickReviewer(['codex', 'gemini'] as const, available('codex', 'gemini'))).toBe('codex');
  });

  it('faller tilbake til Gemini når den foretrukne CLI-en ikke er tilgjengelig', () => {
    expect(pickReviewer(['claude', 'gemini'] as const, available('gemini'))).toBe('gemini');
    expect(pickReviewer(['codex', 'gemini'] as const, available('claude', 'gemini'))).toBe(
      'gemini'
    );
  });

  it('returnerer null (aldri en antatt leverandør) når ingen er tilgjengelig', () => {
    expect(pickReviewer(['claude', 'gemini'] as const, available())).toBeNull();
    expect(pickReviewer(['codex', 'gemini'] as const, available('github'))).toBeNull();
  });
});

describe('reviewHasBlockers', () => {
  it('er true når minst ett funn har severity blocker', () => {
    expect(
      reviewHasBlockers({
        reviewer: 'claude',
        approved: false,
        findings: [{ severity: 'blocker', file: null, summary: 'x' }],
        raw: '',
      })
    ).toBe(true);
  });

  it('er false når ingen funn er blocker', () => {
    expect(
      reviewHasBlockers({
        reviewer: 'claude',
        approved: true,
        findings: [{ severity: 'minor', file: null, summary: 'x' }],
        raw: '',
      })
    ).toBe(false);
  });
});
