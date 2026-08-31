import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractParseError, loadTaskContract } from '../../src/orchestrator/contractIo.js';

describe('loadTaskContract', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'nokto-contract-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('laster en gyldig YAML-kontrakt og fyller inn standardverdier', () => {
    const file = resolve(dir, 'task.yaml');
    writeFileSync(
      file,
      [
        'id: my-task',
        'title: En tittel',
        'goal: Et mål',
        'scope:',
        '  description: x',
        '  allowedPaths: ["src/**"]',
        'acceptanceCriteria: ["x"]',
        'testRequirements:',
        '  commands: ["pnpm run lint"]',
      ].join('\n'),
      'utf8'
    );
    const contract = loadTaskContract(file);
    expect(contract.id).toBe('my-task');
    expect(contract.constraints.maxRetries).toBe(2);
    expect(contract.constraints.allowedImplementers).toEqual(['codex']);
    expect(contract.constraints.reviewers).toEqual(['claude', 'gemini']);
    expect(contract.constraints.secondaryReviewers).toEqual(['codex', 'gemini']);
    expect(contract.git.baseBranch).toBe('main');
  });

  it('avviser gemini som implementerer — provideren har ingen CLI-sandbox', () => {
    const file = resolve(dir, 'gemini-implementer.yaml');
    writeFileSync(
      file,
      [
        'id: my-task',
        'title: En tittel',
        'goal: Et mål',
        'scope:',
        '  description: x',
        '  allowedPaths: ["src/**"]',
        'acceptanceCriteria: ["x"]',
        'testRequirements:',
        '  commands: ["pnpm run lint"]',
        'constraints:',
        '  allowedImplementers: ["gemini"]',
      ].join('\n'),
      'utf8'
    );
    expect(() => loadTaskContract(file)).toThrow(ContractParseError);
  });

  it('godtar gemini i gjennomgangsrollene', () => {
    const file = resolve(dir, 'gemini-reviewer.yaml');
    writeFileSync(
      file,
      [
        'id: my-task',
        'title: En tittel',
        'goal: Et mål',
        'scope:',
        '  description: x',
        '  allowedPaths: ["src/**"]',
        'acceptanceCriteria: ["x"]',
        'testRequirements:',
        '  commands: ["pnpm run lint"]',
        'constraints:',
        '  reviewers: ["gemini"]',
        '  secondaryReviewers: ["gemini"]',
      ].join('\n'),
      'utf8'
    );
    const contract = loadTaskContract(file);
    expect(contract.constraints.reviewers).toEqual(['gemini']);
    expect(contract.constraints.secondaryReviewers).toEqual(['gemini']);
  });

  it('kaster ContractParseError for en fil som ikke finnes', () => {
    expect(() => loadTaskContract(resolve(dir, 'mangler.yaml'))).toThrow(ContractParseError);
  });

  it('kaster ContractParseError når kontrakten mangler påkrevde felt', () => {
    const file = resolve(dir, 'invalid.yaml');
    writeFileSync(file, 'id: my-task\ntitle: kun tittel\n', 'utf8');
    expect(() => loadTaskContract(file)).toThrow(ContractParseError);
  });

  it('kaster ContractParseError for en id som ikke er kebab-case', () => {
    const file = resolve(dir, 'invalid-id.yaml');
    writeFileSync(
      file,
      [
        'id: Ugyldig_ID!',
        'title: x',
        'goal: x',
        'scope:',
        '  description: x',
        '  allowedPaths: ["src/**"]',
        'acceptanceCriteria: ["x"]',
        'testRequirements:',
        '  commands: ["pnpm run lint"]',
      ].join('\n'),
      'utf8'
    );
    expect(() => loadTaskContract(file)).toThrow(ContractParseError);
  });
});
