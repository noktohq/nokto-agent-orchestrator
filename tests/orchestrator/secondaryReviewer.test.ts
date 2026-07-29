import { describe, expect, it } from 'vitest';
import { needsSecondaryReview } from '../../src/orchestrator/secondaryReviewer.js';
import type { ReviewResult } from '../../src/types.js';

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
