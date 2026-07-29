import { runClaude } from '../providers/claude.js';
import { runCodex } from '../providers/codex.js';
import { runDoctor } from '../providers/detect.js';
import type { OrchestratorConfig } from '../config.js';
import type { ProviderName, TaskContract, TaskPlan } from '../types.js';

export class NoImplementerAvailableError extends Error {}

export interface ImplementationOutcome {
  ok: boolean;
  implementer: ProviderName;
  summary: string;
  stderrTail: string;
}

const IMPLEMENTER_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash(git *)',
  'Bash(pnpm *)',
  'Bash(npm *)',
  'Bash(node *)',
  'Bash(tsc *)',
  'Bash(python3 *)',
];

function buildImplementationPrompt(
  contract: TaskContract,
  plan: TaskPlan,
  feedback?: string
): string {
  return [
    `Implementer denne planen i din nåværende arbeidskatalog (en isolert git worktree).`,
    `Endre KUN filer innenfor: ${contract.scope.allowedPaths.join(', ')}.`,
    contract.scope.disallowedPaths.length > 0
      ? `Rør ALDRI: ${contract.scope.disallowedPaths.join(', ')}.`
      : '',
    `Mål: ${contract.goal}`,
    `Plan: ${plan.summary}`,
    `Steg: ${plan.steps.map((s) => `${s.order}. ${s.description}`).join(' | ')}`,
    `Akseptansekriterier som må oppfylles: ${contract.acceptanceCriteria.join('; ')}`,
    feedback
      ? `Dette er et NYTT FORSØK. Forrige forsøk feilet. Rett følgende konkret:\n${feedback}`
      : '',
    `Kommit endringene dine med en beskrivende commit-melding når du er ferdig.`,
    `Ikke push. Ikke opprett pull request. Det gjør orkestratoren.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Ruter implementeringen til en tilgjengelig leverandør fra
 * contract.constraints.allowedImplementers, i prioritert rekkefølge.
 * Kaster NoImplementerAvailableError dersom ingen av de tillatte
 * leverandørene faktisk er installert — later ALDRI som suksess.
 */
export async function implementTask(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan,
  worktreePath: string,
  feedback?: string
): Promise<ImplementationOutcome> {
  const doctor = await runDoctor(config);
  const available = new Set(doctor.filter((d) => d.available).map((d) => d.provider));

  const prompt = buildImplementationPrompt(contract, plan, feedback);

  for (const candidate of contract.constraints.allowedImplementers) {
    if (!available.has(candidate)) continue;

    if (candidate === 'codex') {
      const res = await runCodex(prompt, config, {
        cwd: worktreePath,
        repoRoot: config.repoRoot,
        sandboxOverride: 'workspace-write',
      });
      return {
        ok: res.ok,
        implementer: 'codex',
        summary: res.finalMessage || res.stdoutTail,
        stderrTail: res.stderrTail,
      };
    }

    if (candidate === 'claude') {
      const res = await runClaude(prompt, config, {
        cwd: worktreePath,
        repoRoot: worktreePath,
        permissionMode: 'acceptEdits',
        allowedTools: IMPLEMENTER_ALLOWED_TOOLS,
      });
      return {
        ok: res.ok,
        implementer: 'claude',
        summary: res.resultText,
        stderrTail: res.stderrTail,
      };
    }
  }

  throw new NoImplementerAvailableError(
    `Ingen av de tillatte implementeringsleverandørene (${contract.constraints.allowedImplementers.join(', ')}) er tilgjengelig. Kjør "doctor" for detaljer.`
  );
}
