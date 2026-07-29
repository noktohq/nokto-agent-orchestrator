import { runCommand } from '../providers/exec.js';
import {
  addLabelsToIssue,
  createPullRequest,
  ensureLabelExists,
  resolveRepoRef,
} from '../providers/github.js';
import { scanForSecrets } from '../security/secretScan.js';
import { diffAgainstBase } from './reviewer.js';
import type { OrchestratorConfig } from '../config.js';
import type { ReviewResult, TaskContract, TaskPlan, VerifyResult } from '../types.js';
import type { WorktreeHandle } from './worktree.js';

export class SecretsInDiffError extends Error {}
export class PushBlockedError extends Error {}

const ORCHESTRATOR_LABEL = 'agent-orchestrator';
const ORCHESTRATOR_LABEL_COLOR = '5319e7';

function formatReview(title: string, review: ReviewResult | null): string {
  if (!review) return `### ${title}\nIkke kjørt.`;
  const findings =
    review.findings.length === 0
      ? '- Ingen funn.'
      : review.findings
          .map((f) => `- **${f.severity}** ${f.file ? `\`${f.file}\`: ` : ''}${f.summary}`)
          .join('\n');
  return `### ${title} (${review.reviewer})\nGodkjent: ${review.approved ? 'ja' : 'nei'}\n\n${findings}`;
}

function formatVerify(verify: VerifyResult): string {
  const rows = verify.commands
    .map(
      (c) =>
        `| \`${c.command}\` | ${c.passed ? '✅' : '❌'} | ${c.exitCode ?? 'n/a'} | ${c.durationMs} ms |`
    )
    .join('\n');
  return [
    '### Verifisering',
    `Samlet: ${verify.passed ? '✅ bestått' : '❌ feilet'}`,
    '',
    '| Kommando | Status | Exit | Tid |',
    '|---|---|---|---|',
    rows,
  ].join('\n');
}

function buildPrBody(
  contract: TaskContract,
  plan: TaskPlan,
  review: ReviewResult,
  secondaryReview: ReviewResult | null,
  verify: VerifyResult
): string {
  return [
    `## Mål\n${contract.goal}`,
    `## Plan\n${plan.summary}\n\n${plan.steps.map((s) => `${s.order}. ${s.description}`).join('\n')}`,
    plan.risks.length > 0
      ? `## Kjente risikoer\n${plan.risks.map((r) => `- ${r}`).join('\n')}`
      : '',
    `## Akseptansekriterier\n${contract.acceptanceCriteria.map((a) => `- [x] ${a}`).join('\n')}`,
    formatReview('Kodegjennomgang', review),
    formatReview('Sekundær kontroll', secondaryReview),
    formatVerify(verify),
    `## Sikkerhet\nDiff skannet for hemmeligheter før push — ingen treff. Kommandokjøring gikk gjennom allowlist og worktree-isolasjon.`,
    `---\nOpprettet automatisk av nokto-agent-orchestrator (oppgave-id: \`${contract.id}\`). Ingen automatisk merge.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface CreateTaskPrResult {
  number: number;
  url: string;
  htmlUrl: string;
}

/**
 * Steg 10 — push branch og opprett pull request med full rapport. Skanner
 * ALLTID diffen for hemmeligheter rett før push og blokkerer opprettelsen
 * hardt dersom noe treffer (aldri bare en advarsel). Oppretter ALDRI PR mot
 * `main` med auto-merge — det er opp til et menneske.
 */
export async function createTaskPullRequest(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  review: ReviewResult,
  secondaryReview: ReviewResult | null,
  verify: VerifyResult,
  worktree: WorktreeHandle
): Promise<CreateTaskPrResult> {
  const diff = await diffAgainstBase(config, worktree.path, contract.git.baseBranch);
  const secretHits = scanForSecrets(diff);
  if (secretHits.length > 0) {
    throw new SecretsInDiffError(
      `Diffen inneholder mulige hemmeligheter (${secretHits.map((m) => m.patternName).join(', ')}) — PR blokkert.`
    );
  }

  const pushRes = await runCommand(['git', 'push', '-u', 'origin', worktree.branch], {
    cwd: worktree.path,
    repoRoot: config.repoRoot,
    timeoutMs: 120_000,
  });
  if (!pushRes.ok) {
    throw new PushBlockedError(`git push feilet: ${pushRes.stderr.slice(0, 500)}`);
  }

  const ref = await resolveRepoRef(config);
  const labels = ['agent-generated', ...contract.metadata.labels];

  await ensureLabelExists(config, ref, ORCHESTRATOR_LABEL, ORCHESTRATOR_LABEL_COLOR).catch(
    () => undefined
  );

  const pr = await createPullRequest(config, ref, {
    title: `[agent] ${contract.title}`,
    head: worktree.branch,
    base: contract.git.baseBranch,
    body: buildPrBody(contract, plan, review, secondaryReview, verify),
    draft: false,
  });

  await addLabelsToIssue(config, ref, pr.number, [ORCHESTRATOR_LABEL, ...labels]).catch(
    () => undefined
  );

  return pr;
}
