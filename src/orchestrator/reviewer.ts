import { runClaude } from '../providers/claude.js';
import { runCommand } from '../providers/exec.js';
import type { OrchestratorConfig } from '../config.js';
import type { ReviewResult, TaskContract, TaskPlan } from '../types.js';

const REVIEW_JSON_SCHEMA_HINT = `Svar KUN med gyldig JSON på nøyaktig denne formen, ingen annen tekst:
{
  "approved": boolean,
  "findings": [{"severity": "blocker"|"major"|"minor"|"info", "file": "relative/sti.ts"|null, "summary": "..."}]
}`;

export async function diffAgainstBase(
  config: OrchestratorConfig,
  worktreePath: string,
  baseBranch: string
): Promise<string> {
  const res = await runCommand(['git', 'diff', `origin/${baseBranch}...HEAD`], {
    cwd: worktreePath,
    repoRoot: worktreePath,
    timeoutMs: 30_000,
    readOnly: true,
  });
  return res.stdout;
}

function buildReviewPrompt(contract: TaskContract, plan: TaskPlan, diff: string): string {
  return [
    `Du er en uavhengig kodegjennomgangs-agent. Du har IKKE selv skrevet denne koden.`,
    `Gjennomgå diffen under opp mot målet og akseptansekriteriene. Se etter feil,`,
    `sikkerhetsproblemer, brudd på scope, og avvik fra planen. Vær konkret — vis til fil/linje`,
    `der det er mulig i "summary".`,
    ``,
    `Mål: ${contract.goal}`,
    `Akseptansekriterier: ${contract.acceptanceCriteria.join('; ')}`,
    `Plan som skulle følges: ${plan.summary}`,
    `Tillatte filstier: ${contract.scope.allowedPaths.join(', ')}`,
    contract.scope.disallowedPaths.length > 0
      ? `Forbudte filstier: ${contract.scope.disallowedPaths.join(', ')}`
      : '',
    ``,
    `approved skal være false dersom det finnes minst ett "blocker"-funn, eller dersom`,
    `diffen tydelig ikke oppfyller akseptansekriteriene.`,
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

export function parseReviewResult(reviewer: 'claude' | 'codex', resultText: string): ReviewResult {
  const jsonMatch = /\{[\s\S]*\}/.exec(resultText);
  if (!jsonMatch) {
    return {
      reviewer,
      approved: false,
      findings: [
        {
          severity: 'blocker',
          file: null,
          summary: 'Fant ingen gyldig JSON i gjennomgangsresultatet.',
        },
      ],
      raw: resultText,
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ReviewResult>;
    if (typeof parsed.approved !== 'boolean' || !Array.isArray(parsed.findings)) {
      return {
        reviewer,
        approved: false,
        findings: [
          {
            severity: 'blocker',
            file: null,
            summary: 'Gjennomgangsresultat manglet approved/findings.',
          },
        ],
        raw: resultText,
      };
    }
    return { reviewer, approved: parsed.approved, findings: parsed.findings, raw: resultText };
  } catch (err) {
    return {
      reviewer,
      approved: false,
      findings: [
        {
          severity: 'blocker',
          file: null,
          summary: `Kunne ikke parse gjennomgangsresultat: ${String(err)}`,
        },
      ],
      raw: resultText,
    };
  }
}

/**
 * Claude gjennomfører uavhengig kodegjennomgang av diffen produsert i worktreet
 * — steg 5 i arbeidsflyten. Kjøres med permission-mode "plan" (kun lesing,
 * ingen filendringer), og ser KUN på selve diffen — ikke implementerings-agentens
 * egen oppsummering — slik at gjennomgangen er reelt uavhengig.
 */
export async function reviewCode(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  worktreePath: string
): Promise<ReviewResult> {
  const diff = await diffAgainstBase(config, worktreePath, contract.git.baseBranch);
  if (diff.trim() === '') {
    return {
      reviewer: 'claude',
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

  const outcome = await runClaude(buildReviewPrompt(contract, plan, diff), config, {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    permissionMode: 'plan',
  });

  if (!outcome.ok) {
    return {
      reviewer: 'claude',
      approved: false,
      findings: [
        {
          severity: 'blocker',
          file: null,
          summary: `Kodegjennomgang feilet: ${outcome.stderrTail || 'ukjent feil'}`,
        },
      ],
      raw: outcome.resultText,
    };
  }

  return parseReviewResult('claude', outcome.resultText);
}

export function reviewHasBlockers(review: ReviewResult): boolean {
  return review.findings.some((f) => f.severity === 'blocker');
}
