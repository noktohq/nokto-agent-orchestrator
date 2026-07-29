import { runClaude } from '../providers/claude.js';
import type { OrchestratorConfig } from '../config.js';
import type { TaskContract, TaskPlan } from '../types.js';

const PLAN_JSON_SCHEMA_HINT = `Svar KUN med gyldig JSON på nøyaktig denne formen, ingen annen tekst:
{
  "summary": "kort beskrivelse av løsningen",
  "steps": [{"order": 1, "description": "...", "files": ["relative/sti.ts"]}],
  "risks": ["kjente risikoer eller antakelser"],
  "filesExpectedToChange": ["relative/sti.ts"]
}`;

export class PlanParseError extends Error {}

function buildPlanPrompt(contract: TaskContract): string {
  return [
    `Du er planleggingsagenten i et multi-agent-system. Lag en implementeringsplan for denne oppgaven.`,
    ``,
    `Tittel: ${contract.title}`,
    `Mål: ${contract.goal}`,
    `Scope: ${contract.scope.description}`,
    `Tillatte filstier (glob): ${contract.scope.allowedPaths.join(', ')}`,
    contract.scope.disallowedPaths.length > 0
      ? `Forbudte filstier: ${contract.scope.disallowedPaths.join(', ')}`
      : '',
    `Akseptansekriterier: ${contract.acceptanceCriteria.join('; ')}`,
    `Testkommandoer som må bestå: ${contract.testRequirements.commands.join('; ')}`,
    ``,
    `Planen skal KUN referere filer innenfor tillatte stier. Ikke foreslå endringer`,
    `utenfor scope. Ikke foreslå endringer i .github/workflows/ med mindre det er`,
    `eksplisitt en del av scope.`,
    ``,
    PLAN_JSON_SCHEMA_HINT,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Claude planlegger — steg 1 i arbeidsflyten. Kjøres med permission-mode "plan" (ingen filendringer). */
export async function planTask(
  config: OrchestratorConfig,
  contract: TaskContract
): Promise<TaskPlan> {
  const outcome = await runClaude(buildPlanPrompt(contract), config, {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    permissionMode: 'plan',
  });

  if (!outcome.ok) {
    throw new PlanParseError(
      `Planleggingskall til Claude feilet: ${outcome.stderrTail || 'ukjent feil'} (timeout=${outcome.timedOut})`
    );
  }

  return parsePlan(outcome.resultText);
}

export function parsePlan(resultText: string): TaskPlan {
  const jsonMatch = /\{[\s\S]*\}/.exec(resultText);
  if (!jsonMatch) {
    throw new PlanParseError('Fant ingen JSON i planleggingsresultatet.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new PlanParseError(`Ugyldig JSON i planleggingsresultat: ${String(err)}`);
  }

  const p = parsed as Partial<TaskPlan>;
  if (
    typeof p.summary !== 'string' ||
    !Array.isArray(p.steps) ||
    !Array.isArray(p.risks) ||
    !Array.isArray(p.filesExpectedToChange)
  ) {
    throw new PlanParseError(
      'Planleggingsresultat mangler påkrevde felt (summary/steps/risks/filesExpectedToChange).'
    );
  }

  return {
    summary: p.summary,
    steps: p.steps as TaskPlan['steps'],
    risks: p.risks as string[],
    filesExpectedToChange: p.filesExpectedToChange as string[],
  };
}
