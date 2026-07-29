import { describe, expect, it } from 'vitest';
import { parseReviewResult, reviewHasBlockers } from '../../src/orchestrator/reviewer.js';

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
