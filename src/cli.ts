#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, ConfigError } from './config.js';
import { runDoctor } from './providers/detect.js';
import { planTask } from './orchestrator/planner.js';
import { validatePlan } from './orchestrator/validator.js';
import { reviewCode } from './orchestrator/reviewer.js';
import { runVerify } from './orchestrator/verifier.js';
import { runTask, resumeTask, cancelTask } from './orchestrator/pipeline.js';
import { TaskStore } from './orchestrator/taskStore.js';
import { loadTaskContract } from './orchestrator/contractIo.js';
import type { TaskContract, TaskPlan } from './types.js';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Feil: ${message}\n`);
  process.exit(1);
}

function stubPlan(contract: TaskContract): TaskPlan {
  return {
    summary: `(uten lagret plan) ${contract.goal}`,
    steps: [],
    risks: [],
    filesExpectedToChange: contract.scope.allowedPaths,
  };
}

const program = new Command();
program
  .name('nokto-agent')
  .description(
    'Nokto multi-agent-orkestrator — Claude Code + OpenAI Codex + Google Gemini + GitHub'
  )
  .version('1.0.0');

program
  .command('doctor')
  .description(
    'Sjekker faktisk tilgjengelighet av claude/codex/gh-CLI, GEMINI_API_KEY og GITHUB_TOKEN'
  )
  .action(async () => {
    const config = loadConfig();
    const report = await runDoctor(config);
    printJson(report);
    // Gemini teller ikke som implementerer — den kan kun brukes til gjennomgangsroller.
    const implementerAvailable = report.some(
      (r) => (r.provider === 'claude' || r.provider === 'codex') && r.available
    );
    if (!implementerAvailable) {
      process.stderr.write(
        'Advarsel: verken claude eller codex er tilgjengelig — implementering vil feile.\n'
      );
    }
  });

program
  .command('plan')
  .description('Genererer og skriver ut en implementeringsplan uten å endre noe')
  .requiredOption('--task <fil>', 'sti til oppgavekontrakt (YAML/JSON)')
  .action(async (opts: { task: string }) => {
    const config = loadConfig();
    const contract = loadTaskContract(opts.task);
    const plan = await planTask(config, contract);
    const validation = await validatePlan(config, contract, plan);
    printJson({ plan, validation });
  });

program
  .command('run')
  .description(
    'Kjører hele arbeidsflyten: plan → valider → implementer → gjennomgå → verifiser → PR'
  )
  .requiredOption('--task <fil>', 'sti til oppgavekontrakt (YAML/JSON)')
  .action(async (opts: { task: string }) => {
    const config = loadConfig();
    const contract = loadTaskContract(opts.task);
    const store = new TaskStore(config.stateDir);
    if (store.exists(contract.id)) {
      fail(
        `Oppgave "${contract.id}" finnes allerede i statuslager. Bruk "resume" eller velg en annen id.`
      );
    }
    const state = await runTask({ config, store }, contract);
    printJson(state);
    if (state.phase === 'failed') process.exitCode = 1;
  });

program
  .command('dry-run')
  .description(
    'Kjører plan/valider/worktree-oppsett uten å implementere, gjennomgå eller opprette PR'
  )
  .requiredOption('--task <fil>', 'sti til oppgavekontrakt (YAML/JSON)')
  .action(async (opts: { task: string }) => {
    const config = loadConfig();
    const contract = loadTaskContract(opts.task);
    const store = new TaskStore(config.stateDir);
    const state = await runTask({ config, store }, contract, { dryRun: true });
    printJson(state);
    if (state.phase === 'failed') process.exitCode = 1;
  });

program
  .command('review')
  .description(
    'Kjører en frittstående kodegjennomgang av en gitt worktree/mappe mot en oppgavekontrakt'
  )
  .requiredOption('--task <fil>', 'sti til oppgavekontrakt (YAML/JSON)')
  .requiredOption('--worktree <sti>', 'sti til arbeidskatalogen som skal gjennomgås')
  .action(async (opts: { task: string; worktree: string }) => {
    const config = loadConfig();
    const contract = loadTaskContract(opts.task);
    const result = await reviewCode(config, contract, stubPlan(contract), opts.worktree);
    printJson(result);
    if (!result.approved) process.exitCode = 1;
  });

program
  .command('verify')
  .description('Kjører testRequirements.commands fra oppgavekontrakten i en gitt mappe')
  .requiredOption('--task <fil>', 'sti til oppgavekontrakt (YAML/JSON)')
  .requiredOption('--worktree <sti>', 'sti til arbeidskatalogen som skal verifiseres')
  .action(async (opts: { task: string; worktree: string }) => {
    const config = loadConfig();
    const contract = loadTaskContract(opts.task);
    const result = await runVerify(config, contract, opts.worktree);
    printJson(result);
    if (!result.passed) process.exitCode = 1;
  });

program
  .command('status')
  .description('Viser status for én oppgave (--task-id) eller alle lagrede oppgaver')
  .option('--task-id <id>', 'oppgave-id')
  .action((opts: { taskId?: string }) => {
    const config = loadConfig();
    const store = new TaskStore(config.stateDir);
    if (opts.taskId) {
      if (!store.exists(opts.taskId)) fail(`Ingen lagret oppgave med id "${opts.taskId}".`);
      printJson(store.load(opts.taskId));
      return;
    }
    printJson(
      store.list().map((s) => ({
        id: s.contract.id,
        title: s.contract.title,
        phase: s.phase,
        attempts: s.attempts.length,
        updatedAt: s.updatedAt,
        prUrl: s.prUrl,
      }))
    );
  });

program
  .command('resume')
  .description('Gjenopptar en tidligere avbrutt oppgave fra lagret status')
  .requiredOption('--task-id <id>', 'oppgave-id')
  .action(async (opts: { taskId: string }) => {
    const config = loadConfig();
    const store = new TaskStore(config.stateDir);
    if (!store.exists(opts.taskId)) fail(`Ingen lagret oppgave med id "${opts.taskId}".`);
    const state = await resumeTask({ config, store }, opts.taskId);
    printJson(state);
    if (state.phase === 'failed') process.exitCode = 1;
  });

program
  .command('cancel')
  .description('Kansellerer en pågående oppgave (sjekkes mellom hvert steg i kjøringen)')
  .requiredOption('--task-id <id>', 'oppgave-id')
  .action((opts: { taskId: string }) => {
    const config = loadConfig();
    const store = new TaskStore(config.stateDir);
    if (!store.exists(opts.taskId)) fail(`Ingen lagret oppgave med id "${opts.taskId}".`);
    const state = cancelTask(store, opts.taskId);
    printJson(state);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof ConfigError) {
    fail(err.message);
  }
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
