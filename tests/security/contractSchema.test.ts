import { describe, expect, it } from 'vitest';
import { taskContractSchema } from '../../src/types.js';

function base(git: Record<string, unknown>) {
  return {
    id: 'skjema-test',
    title: 'x',
    goal: 'x',
    scope: { description: 'x', allowedPaths: ['src/**'] },
    acceptanceCriteria: ['x'],
    testRequirements: { commands: ['pnpm test'] },
    git,
  };
}

describe('taskContractSchema: git.branchPrefix og git.baseBranch', () => {
  it('godtar prefiks som slutter på "/"', () => {
    for (const branchPrefix of ['agent/', 'nokto/agent/', 'bot-1/']) {
      expect(taskContractSchema.safeParse(base({ branchPrefix })).success, branchPrefix).toBe(true);
    }
    expect(taskContractSchema.parse(base({})).git.branchPrefix).toBe('agent/');
  });

  it('avviser prefiks uten "/" og ugyldige grennavn', () => {
    for (const branchPrefix of [
      'release',
      'r',
      'agent',
      '/',
      'a//',
      '../',
      'main/',
      '.x/',
      'a b/',
    ]) {
      expect(taskContractSchema.safeParse(base({ branchPrefix })).success, branchPrefix).toBe(
        false
      );
    }
  });

  it('avviser baseBranch med refspec-syntaks', () => {
    for (const baseBranch of ['main:evil', '+main', 'refs/heads/*', 'a..b', '-x']) {
      expect(taskContractSchema.safeParse(base({ baseBranch })).success, baseBranch).toBe(false);
    }
  });
});
