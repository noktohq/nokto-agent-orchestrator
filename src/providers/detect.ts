import { runCommand } from './exec.js';
import type { DoctorReport } from '../types.js';
import type { OrchestratorConfig } from '../config.js';

async function probeVersion(
  bin: string,
  args: string[],
  cwd: string
): Promise<{ available: boolean; version: string | null; detail: string }> {
  try {
    const res = await runCommand([bin, ...args], {
      cwd,
      repoRoot: cwd,
      timeoutMs: 15_000,
      readOnly: true,
      skipAllowlist: true,
    });
    if (res.ok) {
      return { available: true, version: res.stdout.trim().split('\n')[0] ?? null, detail: 'ok' };
    }
    return {
      available: false,
      version: null,
      detail: `exit ${res.exitCode ?? 'n/a'}: ${res.stderr.trim().slice(0, 200)}`,
    };
  } catch (err) {
    return {
      available: false,
      version: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sjekker faktisk tilgjengelighet av alle leverandører. Gjetter aldri —
 * kjører den ekte `--version`/`--help`-kommandoen (eller, for API-baserte
 * leverandører som Gemini, sjekker at nøkkelen faktisk er satt) og
 * rapporterer nøyaktig hva som ble funnet. En leverandør som mangler
 * rapporteres som available: false, aldri simulert som tilgjengelig.
 */
export async function runDoctor(config: OrchestratorConfig): Promise<DoctorReport[]> {
  const reports: DoctorReport[] = [];

  const claude = await probeVersion(config.claudeBin, ['--version'], config.repoRoot);
  reports.push({
    provider: 'claude',
    available: claude.available,
    version: claude.version,
    detail: claude.available
      ? `${config.claudeBin} funnet — bruker ${config.claudeModel ?? 'leverandørens standardmodell'}`
      : `${config.claudeBin} ikke tilgjengelig: ${claude.detail}`,
  });

  const codex = await probeVersion(config.codexBin, ['--version'], config.repoRoot);
  reports.push({
    provider: 'codex',
    available: codex.available,
    version: codex.version,
    detail: codex.available
      ? `${config.codexBin} funnet — sandbox=${config.codexSandbox}`
      : `${config.codexBin} ikke tilgjengelig: ${codex.detail}. Implementeringsoppgaver kan ikke rutes til Codex før CLI-en er installert.`,
  });

  // Gemini er API-basert (ingen CLI å probe): tilgjengelighet = GEMINI_API_KEY
  // er satt. Nøkkelverdien rapporteres aldri, og gyldigheten antas ikke — den
  // verifiseres først ved et faktisk kall (runGemini feiler da synlig).
  const geminiAvailable = config.geminiApiKey !== undefined;
  reports.push({
    provider: 'gemini',
    available: geminiAvailable,
    version: null,
    detail: geminiAvailable
      ? `GEMINI_API_KEY er satt — bruker modell ${config.geminiModel} via @google/genai. Nøkkelens gyldighet verifiseres først ved faktisk kall.`
      : 'GEMINI_API_KEY er ikke satt. Gemini kan ikke brukes til kodegjennomgang/sekundær kontroll før nøkkelen finnes i miljøet.',
  });

  const gh = await probeVersion('gh', ['--version'], config.repoRoot);
  const githubAvailable = gh.available || config.githubToken !== undefined;
  reports.push({
    provider: 'github',
    available: githubAvailable,
    version: gh.version,
    detail: gh.available
      ? `gh CLI funnet: ${gh.version ?? ''}`
      : config.githubToken
        ? 'gh CLI ikke funnet — bruker GitHub REST API via GITHUB_TOKEN'
        : 'Verken gh CLI eller GITHUB_TOKEN er tilgjengelig. GitHub-laget (branch/PR/labels) er utilgjengelig.',
  });

  return reports;
}
