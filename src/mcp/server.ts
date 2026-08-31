#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { runDoctor } from '../providers/detect.js';
import { planTask } from '../orchestrator/planner.js';
import { validatePlan } from '../orchestrator/validator.js';
import { reviewCode } from '../orchestrator/reviewer.js';
import { runTask, resumeTask, cancelTask } from '../orchestrator/pipeline.js';
import { TaskStore } from '../orchestrator/taskStore.js';
import { loadTaskContract } from '../orchestrator/contractIo.js';
import type { TaskContract, TaskPlan } from '../types.js';

/**
 * MCP stdio-server for multi-agent-orkestratoren. Eksponerer de samme 7
 * operasjonene som CLI-en, som MCP-verktøy, slik at Claude Code (eller en
 * annen MCP-klient) kan drive orkestratoren direkte. Deler config/state
 * med CLI-en (samme AGENT_ORCH_STATE_DIR) — kjøres uavhengig av og påvirker
 * ikke de eksisterende Eltempo-/Shopify-MCP-serverne i repoet.
 */

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Feil: ${message}` }], isError: true };
}

function stubPlan(contract: TaskContract): TaskPlan {
  return {
    summary: `(uten lagret plan) ${contract.goal}`,
    steps: [],
    risks: [],
    filesExpectedToChange: contract.scope.allowedPaths,
  };
}

const server = new McpServer({ name: 'nokto-agent-orchestrator', version: '1.0.0' });

server.registerTool(
  'agent_doctor',
  {
    title: 'Doctor',
    description:
      'Sjekker faktisk tilgjengelighet av claude-CLI, codex-CLI, GEMINI_API_KEY og gh-CLI/GITHUB_TOKEN. Gjetter aldri.',
    inputSchema: {},
  },
  async () => {
    try {
      const config = loadConfig();
      return textResult(await runDoctor(config));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_plan_task',
  {
    title: 'Plan task',
    description:
      'Genererer og validerer en implementeringsplan for en oppgavekontrakt, uten å endre noe.',
    inputSchema: { taskFile: z.string().describe('Sti til oppgavekontrakt (YAML/JSON)') },
  },
  async ({ taskFile }) => {
    try {
      const config = loadConfig();
      const contract = loadTaskContract(taskFile);
      const plan = await planTask(config, contract);
      const validation = await validatePlan(config, contract, plan);
      return textResult({ plan, validation });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_run_task',
  {
    title: 'Run task',
    description:
      'Kjører hele arbeidsflyten for en oppgavekontrakt: planlegg, valider, implementer (Codex/Claude), gjennomgå, verifiser, opprett PR. Kan ta lang tid.',
    inputSchema: {
      taskFile: z.string().describe('Sti til oppgavekontrakt (YAML/JSON)'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Kjør kun plan/valider/worktree-oppsett, ingen implementering eller PR'),
    },
  },
  async ({ taskFile, dryRun }) => {
    try {
      const config = loadConfig();
      const contract = loadTaskContract(taskFile);
      const store = new TaskStore(config.stateDir);
      if (store.exists(contract.id) && !dryRun) {
        return errorResult(
          new Error(`Oppgave "${contract.id}" finnes allerede. Bruk agent_resume_task.`)
        );
      }
      const state = await runTask(
        { config, store },
        contract,
        dryRun !== undefined ? { dryRun } : {}
      );
      return textResult(state);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_review_task',
  {
    title: 'Review task',
    description:
      'Kjører en frittstående, uavhengig Claude-kodegjennomgang av en gitt arbeidskatalog mot en oppgavekontrakt.',
    inputSchema: {
      taskFile: z.string().describe('Sti til oppgavekontrakt (YAML/JSON)'),
      worktreePath: z.string().describe('Sti til arbeidskatalogen som skal gjennomgås'),
    },
  },
  async ({ taskFile, worktreePath }) => {
    try {
      const config = loadConfig();
      const contract = loadTaskContract(taskFile);
      return textResult(await reviewCode(config, contract, stubPlan(contract), worktreePath));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_get_status',
  {
    title: 'Get status',
    description: 'Henter status for én oppgave (taskId) eller lister alle lagrede oppgaver.',
    inputSchema: {
      taskId: z.string().optional().describe('Oppgave-id. Utelates for å liste alle.'),
    },
  },
  async ({ taskId }) => {
    try {
      const config = loadConfig();
      const store = new TaskStore(config.stateDir);
      if (taskId) {
        if (!store.exists(taskId))
          return errorResult(new Error(`Ingen lagret oppgave med id "${taskId}".`));
        return textResult(store.load(taskId));
      }
      return textResult(
        store.list().map((s) => ({
          id: s.contract.id,
          title: s.contract.title,
          phase: s.phase,
          attempts: s.attempts.length,
          updatedAt: s.updatedAt,
          prUrl: s.prUrl,
        }))
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_resume_task',
  {
    title: 'Resume task',
    description: 'Gjenopptar en tidligere avbrutt oppgave fra lagret status.',
    inputSchema: { taskId: z.string().describe('Oppgave-id') },
  },
  async ({ taskId }) => {
    try {
      const config = loadConfig();
      const store = new TaskStore(config.stateDir);
      if (!store.exists(taskId))
        return errorResult(new Error(`Ingen lagret oppgave med id "${taskId}".`));
      return textResult(await resumeTask({ config, store }, taskId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'agent_cancel_task',
  {
    title: 'Cancel task',
    description: 'Kansellerer en pågående oppgave. Sjekkes mellom hvert steg av en aktiv kjøring.',
    inputSchema: { taskId: z.string().describe('Oppgave-id') },
  },
  async ({ taskId }) => {
    try {
      const config = loadConfig();
      const store = new TaskStore(config.stateDir);
      if (!store.exists(taskId))
        return errorResult(new Error(`Ingen lagret oppgave med id "${taskId}".`));
      return textResult(cancelTask(store, taskId));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
