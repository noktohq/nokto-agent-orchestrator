import { runCommand } from '../providers/exec.js';
import {
  addLabelsToIssue,
  createPullRequest,
  ensureLabelExists,
  resolveRepoRef,
} from '../providers/github.js';
import { resolvePushPolicy } from '../security/pushPolicy.js';
import { assertDiffWithinScope } from '../security/scope.js';
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
    `## Sikkerhet\nDiffen er sjekket mot oppgavens scope (allowedPaths/disallowedPaths, hard-blokkerte stier, symlenker, submoduler) og skannet for hemmeligheter rett før push — ingen brudd. Kommandokjøring gikk gjennom allowlist og worktree-isolasjon.`,
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
 * Steg 10 — push branch og opprett pull request med full rapport. Rett før push
 * sjekkes den faktiske diffen mot oppgavens scope (assertDiffWithinScope) og
 * skannes for hemmeligheter; begge blokkerer hardt (aldri bare en advarsel).
 * Pushen sender nøyaktig den sjekkede commiten til `refs/heads/<agentgren>`, med
 * hooks av og push-policyen (beskyttede grener + grenprefiks) håndhevet. Oppretter
 * ALDRI PR med auto-merge — det er opp til et menneske.
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
  // Kaster ScopeViolationError/ScopeInspectionError — da pushes ingenting.
  const scope = await assertDiffWithinScope(config, contract, worktree);

  const diff = await diffAgainstBase(config, worktree.path, contract.git.baseBranch);
  const secretHits = scanForSecrets(diff);
  if (secretHits.length > 0) {
    throw new SecretsInDiffError(
      `Diffen inneholder mulige hemmeligheter (${secretHits.map((m) => m.patternName).join(', ')}) — PR blokkert.`
    );
  }

  const pushPolicy = await resolvePushPolicy(config, contract);

  // Eksplisitt <sjekket commit>:refs/heads/<gren>: en refspec uten mål kan omdirigeres av
  // remote.origin.push i git-konfigurasjonen, som agenten kan ha endret. Hooks er av, så
  // en pre-push- eller reference-transaction-hook fra agenten ikke kjøres med
  // orkestratorens tilganger.
  const pushRes = await runCommand(
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--no-verify',
      'origin',
      `${scope.headSha}:refs/heads/${worktree.branch}`,
    ],
    {
      cwd: worktree.path,
      repoRoot: config.repoRoot,
      timeoutMs: 120_000,
      pushPolicy: {
        protectedBranches: pushPolicy.protectedBranches,
        branchPrefix: pushPolicy.branchPrefix,
      },
    }
  );
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
