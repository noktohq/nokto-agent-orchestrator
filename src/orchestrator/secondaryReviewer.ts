import { runCodex } from '../providers/codex.js';
import { diffAgainstBase, parseReviewResult } from './reviewer.js';
import type { OrchestratorConfig } from '../config.js';
import type { ProviderName, ReviewResult, TaskContract, TaskPlan } from '../types.js';

const REVIEW_JSON_SCHEMA_HINT = `Svar KUN med gyldig JSON på nøyaktig denne formen, ingen annen tekst:
{
  "approved": boolean,
  "findings": [{"severity": "blocker"|"major"|"minor"|"info", "file": "relative/sti.ts"|null, "summary": "..."}]
}`;

/**
 * Avgjør om Codex bør brukes som sekundær kontrollagent ("ved behov", steg 6).
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
 * Codex som sekundær kontrollagent — steg 6 i arbeidsflyten. Kjøres alltid
 * med sandbox "read-only": sekundærgjennomgangen skal aldri kunne endre filer.
 * Returnerer null (ikke en falsk "approved") dersom Codex ikke er installert —
 * kalleren må håndtere det eksplisitt i stedet for å anta suksess.
 */
export async function secondaryReviewCode(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  worktreePath: string
): Promise<ReviewResult | null> {
  const diff = await diffAgainstBase(config, worktreePath, contract.git.baseBranch);
  if (diff.trim() === '') {
    return {
      reviewer: 'codex',
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

  const res = await runCodex(buildSecondaryReviewPrompt(contract, plan, diff), config, {
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
