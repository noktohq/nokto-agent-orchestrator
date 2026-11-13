import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaude } from '../providers/claude.js';
import { checkPathAgainstScope } from '../security/scope.js';
import { scanForSecrets } from '../security/secretScan.js';
import type { OrchestratorConfig } from '../config.js';
import type { TaskContract, TaskPlan } from '../types.js';

export interface PlanValidation {
  approved: boolean;
  reasons: string[];
}

/**
 * Kvalitets-/sikkerhetsprofiler LLM-valideringen vurderer planen mot.
 * Konfigurerbar via AGENT_PROFILE_FILES (kommaseparerte stier relative til
 * repo-roten). Uten profiler kjøres kun den statiske valideringen.
 */
function profileFiles(): string[] {
  return (process.env.AGENT_PROFILE_FILES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function staticValidate(contract: TaskContract, plan: TaskPlan): PlanValidation {
  const reasons: string[] = [];

  // Samme path-policy som håndheves mot den faktiske diffen (src/security/scope.ts).
  // Planer kan oppgi "./sti"; git rapporterer aldri det, så det fjernes før sjekken.
  for (const file of plan.filesExpectedToChange) {
    const normalized = file.startsWith('./') ? file.slice(2) : file;
    for (const v of checkPathAgainstScope(normalized, contract.scope)) {
      reasons.push(v.reason);
    }
  }

  const planSecretHits = scanForSecrets(JSON.stringify(plan));
  if (planSecretHits.length > 0) {
    reasons.push(
      `Planen inneholder noe som ligner en hemmelighet (${planSecretHits.map((m) => m.patternName).join(', ')}).`
    );
  }

  return { approved: reasons.length === 0, reasons };
}

function readProfiles(repoRoot: string): string {
  return profileFiles()
    .map((f) => {
      try {
        return `## ${f}\n${readFileSync(resolve(repoRoot, f), 'utf8')}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Validerer planen mot konfigurerte kvalitetsprofiler og sikkerhetsregler —
 * steg 2 i arbeidsflyten. Statisk sjekk (scope/hardblokkerte stier/
 * hemmeligheter) kjøres alltid. LLM-sjekk mot profilfilene (se
 * AGENT_PROFILE_FILES) kjøres i tillegg når Claude er tilgjengelig, og kan
 * avvise en plan selv om de statiske sjekkene passerer.
 */
export async function validatePlan(
  config: OrchestratorConfig,
  contract: TaskContract,
  plan: TaskPlan
): Promise<PlanValidation> {
  const staticResult = staticValidate(contract, plan);
  if (!staticResult.approved) {
    return staticResult;
  }

  const profiles = readProfiles(config.repoRoot);
  if (!profiles) {
    return {
      approved: true,
      reasons: ['Ingen profilfiler funnet — kun statisk validering kjørt.'],
    };
  }

  const prompt = [
    'Du validerer en implementeringsplan mot dette repoets kodekontrakt og sikkerhetsregler.',
    'Svar KUN med JSON: {"approved": boolean, "reasons": ["..."]}.',
    'Avvis planen (approved: false) hvis den bryter en eksplisitt regel i profilene under,',
    'eller hvis den er tydelig ufullstendig for målet den skal oppnå.',
    '',
    `Mål: ${contract.goal}`,
    `Plan: ${JSON.stringify(plan)}`,
    '',
    profiles.slice(0, 20_000),
  ].join('\n');

  const outcome = await runClaude(prompt, config, {
    cwd: config.repoRoot,
    repoRoot: config.repoRoot,
    permissionMode: 'plan',
  });

  if (!outcome.ok) {
    return {
      approved: false,
      reasons: [`Kunne ikke kjøre LLM-validering: ${outcome.stderrTail || 'ukjent feil'}`],
    };
  }

  const jsonMatch = /\{[\s\S]*\}/.exec(outcome.resultText);
  if (!jsonMatch) {
    return { approved: false, reasons: ['LLM-validering returnerte ikke gyldig JSON.'] };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<PlanValidation>;
    if (typeof parsed.approved !== 'boolean' || !Array.isArray(parsed.reasons)) {
      return { approved: false, reasons: ['LLM-validering returnerte uventet form.'] };
    }
    return { approved: parsed.approved, reasons: parsed.reasons as string[] };
  } catch {
    return { approved: false, reasons: ['Kunne ikke parse LLM-valideringsrespons.'] };
  }
}
