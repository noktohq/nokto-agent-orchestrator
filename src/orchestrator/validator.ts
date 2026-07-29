import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaude } from '../providers/claude.js';
import { matchesAnyGlob } from '../security/glob.js';
import { scanForSecrets } from '../security/secretScan.js';
import type { OrchestratorConfig } from '../config.js';
import type { TaskContract, TaskPlan } from '../types.js';

export interface PlanValidation {
  approved: boolean;
  reasons: string[];
}

const HARD_BLOCKED_GLOBS = [
  '.git/**',
  '.github/workflows/**',
  '**/.env',
  '**/.env.*',
  '**/config.json',
];

/** Alltid tillatt selv om de matcher HARD_BLOCKED_GLOBS-mønstre — f.eks. `.env.example`. */
const HARD_BLOCK_EXCEPTIONS = ['**/.env.example'];

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

  for (const file of plan.filesExpectedToChange) {
    if (file.startsWith('/') || file.includes('..')) {
      reasons.push(`Filsti "${file}" er absolutt eller inneholder "..": ikke tillatt.`);
      continue;
    }
    if (!matchesAnyGlob(file, contract.scope.allowedPaths)) {
      reasons.push(
        `Filsti "${file}" er utenfor tillatt scope (${contract.scope.allowedPaths.join(', ')}).`
      );
    }
    if (matchesAnyGlob(file, contract.scope.disallowedPaths)) {
      reasons.push(`Filsti "${file}" matcher en eksplisitt forbudt sti.`);
    }
    const isHardBlocked =
      matchesAnyGlob(file, HARD_BLOCKED_GLOBS) && !matchesAnyGlob(file, HARD_BLOCK_EXCEPTIONS);
    if (isHardBlocked) {
      reasons.push(`Filsti "${file}" er alltid blokkert (hemmeligheter/CI-rettigheter): ${file}.`);
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
