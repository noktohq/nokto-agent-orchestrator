import { afterEach, describe, expect, it, vi } from 'vitest';

interface GenerateContentRequest {
  model: string;
  contents: string;
  config?: {
    abortSignal?: AbortSignal;
    responseMimeType?: string;
  };
}

const generateContentMock =
  vi.fn<(req: GenerateContentRequest) => Promise<{ text: string | undefined }>>();
const constructorOptions: Array<{ apiKey?: string }> = [];

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly models = { generateContent: generateContentMock };
    constructor(options: { apiKey?: string }) {
      constructorOptions.push(options);
    }
  },
}));

const { runGemini } = await import('../../src/providers/gemini.js');

function fakeConfig(overrides: Partial<Record<string, unknown>> = {}) {
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
    codexSandbox: 'workspace-write' as const,
    codexTimeoutSec: 1800,
    geminiApiKey: 'test-gemini-key-not-a-real-secret',
    geminiModel: 'gemini-3.5-flash',
    geminiTimeoutSec: 600,
    githubToken: undefined,
    githubApiBase: 'https://api.github.com',
    githubOwner: undefined,
    githubRepo: undefined,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('runGemini', () => {
  afterEach(() => {
    generateContentMock.mockReset();
    constructorOptions.length = 0;
  });

  it('kaller SDK-en med konfigurert modell og returnerer resultat-teksten', async () => {
    generateContentMock.mockResolvedValue({ text: '{"approved": true, "findings": []}' });

    const outcome = await runGemini('se over diffen', fakeConfig(), { jsonOutput: true });

    expect(outcome.ok).toBe(true);
    expect(outcome.resultText).toBe('{"approved": true, "findings": []}');
    expect(outcome.timedOut).toBe(false);

    expect(constructorOptions[0]?.apiKey).toBe('test-gemini-key-not-a-real-secret');
    const [req] = generateContentMock.mock.calls[0] as [GenerateContentRequest];
    expect(req.model).toBe('gemini-3.5-flash');
    expect(req.contents).toBe('se over diffen');
    expect(req.config?.responseMimeType).toBe('application/json');
    expect(req.config?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('respekterer GEMINI_MODEL-overstyring og utelater responseMimeType uten jsonOutput', async () => {
    generateContentMock.mockResolvedValue({ text: 'ok' });

    await runGemini('hei', fakeConfig({ geminiModel: 'gemini-3.5-pro' }));

    const [req] = generateContentMock.mock.calls[0] as [GenerateContentRequest];
    expect(req.model).toBe('gemini-3.5-pro');
    expect(req.config?.responseMimeType).toBeUndefined();
  });

  it('er utilgjengelig uten GEMINI_API_KEY — ingen nettverkskall, aldri simulert suksess', async () => {
    const outcome = await runGemini('hei', fakeConfig({ geminiApiKey: undefined }));

    expect(outcome.ok).toBe(false);
    expect(outcome.stderrTail).toContain('GEMINI_API_KEY');
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('tom respons er IKKE suksess', async () => {
    generateContentMock.mockResolvedValue({ text: undefined });
    const outcome = await runGemini('hei', fakeConfig());
    expect(outcome.ok).toBe(false);
    expect(outcome.resultText).toBe('');
    expect(outcome.stderrTail).toContain('tom respons');
  });

  it('markerer ok=false ved API-feil og lekker aldri API-nøkkelen i feilmeldingen', async () => {
    generateContentMock.mockRejectedValue(
      new Error('401 Unauthorized for key test-gemini-key-not-a-real-secret')
    );

    const outcome = await runGemini('hei', fakeConfig());

    expect(outcome.ok).toBe(false);
    expect(outcome.stderrTail).not.toContain('test-gemini-key-not-a-real-secret');
    expect(outcome.stderrTail).toContain('[GEMINI_API_KEY]');
  });

  it('markerer timedOut når kallet avbrytes av timeout', async () => {
    generateContentMock.mockImplementation(
      ({ config }) =>
        new Promise((_, reject) => {
          config?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted'))
          );
        })
    );

    const outcome = await runGemini('hei', fakeConfig({ geminiTimeoutSec: 0.05 }));

    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
  });
});
