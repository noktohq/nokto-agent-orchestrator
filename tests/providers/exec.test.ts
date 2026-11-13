import { describe, expect, it } from 'vitest';
import { MAX_CAPTURE_BYTES, runCommand } from '../../src/providers/exec.js';

const opts = { cwd: process.cwd(), repoRoot: '/ingen-repo-rot', timeoutMs: 20_000 };

describe('runCommand (ekte prosess)', () => {
  it('dekoder et flerbytetegn som deles over to skrivinger riktig', async () => {
    // «æ» = C3 A6, skrevet som to separate biter med pause imellom.
    const res = await runCommand(
      [
        'node',
        '-e',
        'process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa6])),50)',
      ],
      opts
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('æ');
    expect(res.stdout).not.toContain('�');
    expect(res.stdoutTruncated).toBe(false);
  });

  it('teller fangstgrensen i byte og markerer avkortet output', async () => {
    // 1,1 M tegn «æ» = 2,2 MB > MAX_CAPTURE_BYTES, men færre tegn enn grensen.
    const res = await runCommand(
      ['node', '-e', "process.stdout.write('æ'.repeat(1_100_000))"],
      opts
    );
    expect(res.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBeLessThanOrEqual(MAX_CAPTURE_BYTES + 3);
  });
});
