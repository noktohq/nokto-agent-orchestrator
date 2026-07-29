import { describe, expect, it } from 'vitest';
import { matchesAnyGlob } from '../../src/security/glob.js';

describe('matchesAnyGlob', () => {
  it('matcher eksakt sti', () => {
    expect(matchesAnyGlob('README.md', ['README.md'])).toBe(true);
    expect(matchesAnyGlob('OTHER.md', ['README.md'])).toBe(false);
  });

  it('matcher * innen ett stinivå', () => {
    expect(matchesAnyGlob('src/index.ts', ['src/*.ts'])).toBe(true);
    expect(matchesAnyGlob('src/nested/index.ts', ['src/*.ts'])).toBe(false);
  });

  it('matcher ** på vilkårlig dybde', () => {
    expect(matchesAnyGlob('src/orchestrator/pipeline.ts', ['src/**'])).toBe(true);
    expect(matchesAnyGlob('src/a/b/c/d.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesAnyGlob('README.md', ['src/**'])).toBe(false);
  });

  it('matcher .env.example som unntak fra .env-mønstre', () => {
    expect(matchesAnyGlob('some/nested/dir/.env', ['**/.env'])).toBe(true);
    expect(matchesAnyGlob('some/nested/dir/.env.example', ['**/.env.example'])).toBe(true);
  });
});
