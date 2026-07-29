import { describe, expect, it } from 'vitest';
import { containsSecret, redact, scanForSecrets } from '../../src/security/secretScan.js';

describe('scanForSecrets / redact', () => {
  it('finner GitHub-tokens', () => {
    const hits = scanForSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(hits.some((h) => h.patternName === 'github-token')).toBe(true);
  });

  it('finner OpenAI- og Anthropic-nøkler', () => {
    expect(
      scanForSecrets('sk-proj-' + 'a'.repeat(24)).some((h) => h.patternName === 'openai-key')
    ).toBe(true);
    expect(
      scanForSecrets('sk-ant-' + 'b'.repeat(24)).some((h) => h.patternName === 'anthropic-key')
    ).toBe(true);
  });

  it('finner generisk tildelt hemmelighet', () => {
    const hits = scanForSecrets('STRIPE_SECRET_KEY=sk_live_' + 'x'.repeat(20));
    expect(hits.some((h) => h.patternName === 'generic-assigned-secret')).toBe(true);
  });

  it('finner ingenting i vanlig, uskyldig tekst', () => {
    expect(
      scanForSecrets('Dette er en helt vanlig commit-melding om en feilrettelse.')
    ).toHaveLength(0);
    expect(containsSecret('README.md oppdatert med ny seksjon.')).toBe(false);
  });

  it('redigerer hemmeligheter uten å beholde full verdi', () => {
    const original = 'GITHUB_TOKEN=ghp_' + 'z'.repeat(36);
    const redacted = redact(original);
    expect(redacted).not.toContain('z'.repeat(36));
    expect(redacted).toContain('[REDACTED]');
  });

  it('containsSecret er true når scanForSecrets finner treff', () => {
    expect(containsSecret('AKIA' + 'A'.repeat(16))).toBe(true);
  });
});
