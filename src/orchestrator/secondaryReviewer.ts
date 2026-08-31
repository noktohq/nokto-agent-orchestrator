import { runCodex } from '../providers/codex.js';
import { runGemini } from '../providers/gemini.js';
import { runDoctor } from '../providers/detect.js';
import { diffAgainstBase, parseReviewResult, pickReviewer } from './reviewer.js';
import type { OrchestratorConfig } from '../config.js';
import type { ProviderName, ReviewResult, TaskContract, TaskPlan } from '../types.js';

const REVIEW_JSON_SCHEMA_HINT = `Svar KUN med gyldig JSON på nøyaktig denne formen, ingen annen tekst:
{
  "approved": boolean,
  "findings": [{"severity": "blocker"|"major"|"minor"|"info", "file": "relative/sti.ts"|null, "summary": "..."}]
}`;

/**
 * Avgjør om en sekundær kontrollagent (Codex/Gemini) bør brukes ("ved behov", steg 6).
 * Sekundær gjennomgang trigges når:
 *  - Codex faktisk var implementerende agent (Claude bør da kontrollere — men det
 *    dekkes allerede av reviewCode()), ELLER
 *  - Claude var implementerende agent OG Claude selv var primærgjennomgang, slik at
 *    en andre, uavhengig modell/leverandør ser på diffen før PR, ELLER
 *  - primærgjennomgangen fant "major"-funn (ikke blocker — de stopper allerede
 *    forsøket) og en ekstra vurdering er nyttig før PR opprettes.
 */
export function needsSecondaryReview(
  implementer: ProviderName,
  primaryReview: ReviewResult
): boolean {
  if (implementer === 'claude') return true;
  return primaryReview.findings.some((f) => f.severity === 'major');
}

function buildSecondaryReviewPrompt(contract: TaskContract, plan: TaskPlan, diff: string): string {
  return [
    `Du er en sekundær, uavhengig kontrollagent i et multi-agent-system. En annen agent`,
    `har allerede implementert og fått en første kodegjennomgang. Din jobb er å gi en`,
    `uavhengig andre vurdering av diffen — ikke stol blindt på at forrige gjennomgang var riktig.`,
    ``,
    `Mål: ${contract.goal}`,
    `Akseptansekriterier: ${contract.acceptanceCriteria.join('; ')}`,
    `Plan som skulle følges: ${plan.summary}`,
    `Tillatte filstier: ${contract.scope.allowedPaths.join(', ')}`,
    contract.scope.disallowedPaths.length > 0
      ? `Forbudte filstier: ${contract.scope.disallowedPaths.join(', ')}`
      : '',
    ``,
    `approved skal være false dersom det finnes minst ett "blocker"-funn.`,
    `Du har KUN lesetilgang — ikke gjør endringer.`,
    ``,
    REVIEW_JSON_SCHEMA_HINT,
    ``,
    `--- DIFF (git diff origin/${contract.git.baseBranch}...HEAD) ---`,
    diff.length > 60_000
      ? `${diff.slice(0, 60_000)}\n... [diff kuttet, ${diff.length} tegn totalt]`
      : diff,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sekundær kontrollagent — steg 6 i arbeidsflyten. Leverandøren velges fra
 * contract.constraints.secondaryReviewers i prioritert rekkefølge (standard:
 * Codex, deretter Gemini når Codex-CLI-en ikke er installert). Begge er reelt
 * lesende: Codex kjøres alltid med sandbox "read-only", og Gemini kalles via
 * API og mottar KUN diff-teksten — sekundærgjennomgangen skal aldri kunne
 * endre filer. Returnerer null (ikke en falsk "approved") dersom ingen av de
 * tillatte leverandørene er tilgjengelig — kalleren må håndtere det eksplisitt
 * i stedet for å anta suksess.
 */
export async function secondaryReviewCode(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  worktreePath: string
): Promise<ReviewResult | null> {
  const doctor = await runDoctor(config);
  const available = new Set(doctor.filter((d) => d.available).map((d) => d.provider));
  const reviewer = pickReviewer(contract.constraints.secondaryReviewers, available);
  if (!reviewer) return null;

  const diff = await diffAgainstBase(config, worktreePath, contract.git.baseBranch);
  if (diff.trim() === '') {
    return {
      reviewer,
      approved: false,
      findings: [
        {
          severity: 'blocker',
          file: null,
          summary: 'Ingen endringer funnet i worktreet (tom diff).',
        },
      ],
      raw: '',
    };
  }

  const prompt = buildSecondaryReviewPrompt(contract, plan, diff);

  if (reviewer === 'gemini') {
    const outcome = await runGemini(prompt, config, { jsonOutput: true });
    if (!outcome.ok) {
      return {
        reviewer: 'gemini',
        approved: false,
        findings: [
          {
            severity: 'blocker',
            file: null,
            summary: `Sekundær Gemini-gjennomgang feilet: ${outcome.stderrTail || 'ukjent feil'}`,
          },
        ],
        raw: outcome.resultText,
      };
    }
    return parseReviewResult('gemini', outcome.resultText);
  }

  const res = await runCodex(prompt, config, {
    cwd: worktreePath,
    repoRoot: config.repoRoot,
    sandboxOverride: 'read-only',
  });

  if (!res.ok) {
    return {
      reviewer: 'codex',
      approved: false,
      findings: [
        {
          severity: 'blocker',
          file: null,
          summary: `Sekundær Codex-gjennomgang feilet: ${res.stderrTail || 'ukjent feil'}`,
        },
      ],
      raw: res.finalMessage || res.stdoutTail,
    };
  }

  return parseReviewResult('codex', res.finalMessage || res.stdoutTail);
}
