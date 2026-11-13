import { runCommand } from '../providers/exec.js';
import {
  addLabelsToIssue,
  createPullRequest,
  ensureLabelExists,
  resolveRepoRef,
} from '../providers/github.js';
import {
  assertBaseOnRemote,
  assertGitConfigUnchanged,
  GIT_SAFETY_ARGS,
  inspectionGitEnv,
  remoteGitEnv,
} from '../security/gitIntegrity.js';
import { resolvePushPolicy } from '../security/pushPolicy.js';
import { assertDiffWithinScope, ScopeInspectionError } from '../security/scope.js';
import { scanForSecrets } from '../security/secretScan.js';
import { FAITHFUL_DIFF_FLAGS } from './reviewer.js';
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
    `## Sikkerhet\nNettodiffen og hver commit er sjekket mot oppgavens scope (allowedPaths/disallowedPaths, hard-blokkerte stier, symlenker, submoduler, merges), og hver commit er skannet for hemmeligheter rett før push — ingen brudd. Base-commiten er bekreftet i remote-grenen. Kommandokjøring gikk gjennom allowlist og worktree-isolasjon.`,
    `---\nOpprettet automatisk av nokto-agent-orchestrator (oppgave-id: \`${contract.id}\`). Ingen automatisk merge.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Alle commits som pushes (base..head), hver med sin patch, slik git lagrer dem. En
 * hemmelighet som legges til i én commit og fjernes i en senere, havner også på remote.
 * Fail closed: git-feil eller output som kan være avkortet → ScopeInspectionError.
 */
async function readCommitPatches(
  worktreePath: string,
  baseSha: string,
  headSha: string
): Promise<string> {
  const res = await runCommand(
    [
      'git',
      ...GIT_SAFETY_ARGS,
      'log',
      '-p',
      '--format=commit %H',
      ...FAITHFUL_DIFF_FLAGS,
      `${baseSha}..${headSha}`,
      '--',
    ],
    {
      cwd: worktreePath,
      repoRoot: worktreePath,
      timeoutMs: 60_000,
      readOnly: true,
      env: inspectionGitEnv(),
    }
  );
  if (!res.ok) {
    throw new ScopeInspectionError(
      `git log -p for hemmelighetsskanning feilet: ${res.stderr.trim().slice(0, 300)}`
    );
  }
  if (res.stdoutTruncated === true) {
    throw new ScopeInspectionError(
      'Patchene er for store til å skannes fullstendig for hemmeligheter — push stoppet.'
    );
  }
  if (res.stdout.trim() === '') {
    throw new ScopeInspectionError('Fant ingen commits å skanne — push stoppet.');
  }
  return res.stdout;
}

export interface CreateTaskPrOptions {
  /**
   * Fingeravtrykk av git-konfigurasjonen tatt før agenten kjørte (gitConfigDigest).
   * Settes det, stopper pushen hvis konfigurasjonen er endret siden.
   */
  gitConfigDigest?: string;
}

export interface CreateTaskPrResult {
  number: number;
  url: string;
  htmlUrl: string;
}

/**
 * Steg 10 — push branch og opprett pull request med full rapport. Rett før push:
 *
 * 1. scope-vakten (assertDiffWithinScope) sjekker nettodiffen og hver commit,
 * 2. git-konfigurasjonen må være uendret siden før agenten kjørte (når oppgitt),
 * 3. base-commiten må finnes i remote-grenen (hentet med orkestratorens egen refspec),
 *    så pushen ikke tar med commits vakten ikke har sett,
 * 4. hver commit som pushes skannes for hemmeligheter.
 *
 * Alle blokkerer hardt. Pushen sender nøyaktig den sjekkede commiten til
 * `refs/heads/<agentgren>`, med hooks av og push-policyen håndhevet. Oppretter ALDRI
 * PR med auto-merge — det er opp til et menneske.
 */
export async function createTaskPullRequest(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  review: ReviewResult,
  secondaryReview: ReviewResult | null,
  verify: VerifyResult,
  worktree: WorktreeHandle,
  opts: CreateTaskPrOptions = {}
): Promise<CreateTaskPrResult> {
  // Kaster ScopeViolationError/ScopeInspectionError — da pushes ingenting.
  const scope = await assertDiffWithinScope(config, contract, worktree);

  // Kaster GitIntegrityError.
  if (opts.gitConfigDigest !== undefined) {
    await assertGitConfigUnchanged(config, opts.gitConfigDigest);
  }
  await assertBaseOnRemote(config, contract.id, contract.git.baseBranch, scope.baseSha);

  const patches = await readCommitPatches(worktree.path, scope.baseSha, scope.headSha);
  const secretHits = scanForSecrets(patches);
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
      ...GIT_SAFETY_ARGS,
      'push',
      '--no-verify',
      'origin',
      `${scope.headSha}:refs/heads/${worktree.branch}`,
    ],
    {
      cwd: worktree.path,
      repoRoot: config.repoRoot,
      timeoutMs: 120_000,
      env: remoteGitEnv(),
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
