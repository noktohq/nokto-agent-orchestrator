import { GoogleGenAI } from '@google/genai';
import { tail } from './exec.js';
import type { OrchestratorConfig } from '../config.js';

/**
 * Gemini-provider — kaller Google Gemini-API-et direkte via den offisielle
 * Google GenAI SDK-en (@google/genai). Kallformen er hentet fra offisiell
 * SDK-dokumentasjon (googleapis/js-genai) og typene i den installerte pakken:
 *
 *   ai.models.generateContent({ model, contents, config: { abortSignal,
 *     responseMimeType } }) → response.text
 *
 * I motsetning til claude/codex finnes det ingen CLI med verktøytilgang her:
 * Gemini mottar KUN prompt-teksten og kan strukturelt sett aldri lese eller
 * endre filer. Provideren brukes derfor utelukkende til leseroller
 * (kodegjennomgang og sekundær kontroll) — ALDRI som implementerende agent.
 *
 * API-nøkkelen leses fra GEMINI_API_KEY (se config.ts) og sendes kun til
 * SDK-en — aldri i argv, aldri til logg. Feilmeldinger renses for nøkkelen
 * før de returneres. Gemini-API-et krever et eksplisitt modellnavn per kall;
 * det kommer fra GEMINI_MODEL med en dokumentert standardverdi.
 */
export interface RunGeminiOptions {
  /** Be API-et om ren JSON (responseMimeType application/json) — for roller med strengt JSON-svar. */
  jsonOutput?: boolean;
}

export interface GeminiOutcome {
  ok: boolean;
  resultText: string;
  stderrTail: string;
  timedOut: boolean;
}

/** Fjerner API-nøkkelen fra en feilmelding før den returneres — nøkkelen skal aldri kunne lekke via logg. */
function stripApiKey(text: string, apiKey: string): string {
  return text.split(apiKey).join('[GEMINI_API_KEY]');
}

export async function runGemini(
  prompt: string,
  config: OrchestratorConfig,
  opts: RunGeminiOptions = {}
): Promise<GeminiOutcome> {
  if (!config.geminiApiKey) {
    return {
      ok: false,
      resultText: '',
      stderrTail: 'GEMINI_API_KEY er ikke satt — Gemini-provideren er utilgjengelig.',
      timedOut: false,
    };
  }

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const controller = new AbortController();
  const killTimer = setTimeout(() => controller.abort(), config.geminiTimeoutSec * 1000);

  try {
    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        abortSignal: controller.signal,
        ...(opts.jsonOutput ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const resultText = response.text ?? '';
    // En tom respons er IKKE suksess — et resultat som ikke finnes kan vi ikke
    // stole på. Later aldri som suksess i et slikt tilfelle.
    return {
      ok: resultText.trim() !== '',
      resultText,
      stderrTail: resultText.trim() === '' ? 'Gemini returnerte tom respons.' : '',
      timedOut: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      resultText: '',
      stderrTail: tail(stripApiKey(message, config.geminiApiKey)),
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(killTimer);
  }
}
