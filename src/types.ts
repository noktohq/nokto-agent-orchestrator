import { z } from 'zod';

/**
 * Oppgavekontrakt — enkelt kilde til sannhet for hva en agent-kjøring skal gjøre.
 * Lastes fra YAML (tasks/*.yaml) og valideres strengt før noe kjøres.
 */
export const taskContractSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/, 'id må være lowercase kebab-case, 2-63 tegn'),
  title: z.string().min(1),
  goal: z.string().min(1),
  scope: z.object({
    description: z.string().min(1),
    allowedPaths: z.array(z.string().min(1)).min(1),
    disallowedPaths: z.array(z.string().min(1)).default([]),
  }),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  testRequirements: z.object({
    commands: z.array(z.string().min(1)).min(1),
    mustPass: z.boolean().default(true),
  }),
  constraints: z
    .object({
      maxRetries: z.number().int().min(0).max(10).default(2),
      timeoutMinutes: z.number().int().min(1).max(180).default(30),
      maxCostUsd: z.number().positive().optional(),
      allowedImplementers: z
        .array(z.enum(['codex', 'claude']))
        .min(1)
        .default(['codex']),
    })
    .default({}),
  git: z
    .object({
      baseBranch: z.string().min(1).default('main'),
      branchPrefix: z.string().min(1).default('agent/'),
    })
    .default({}),
  metadata: z
    .object({
      createdBy: z.string().optional(),
      labels: z.array(z.string()).default([]),
    })
    .default({}),
});

export type TaskContract = z.infer<typeof taskContractSchema>;

export const taskPhaseSchema = z.enum([
  'created',
  'planning',
  'plan_validated',
  'implementing',
  'reviewing',
  'secondary_review',
  'verifying',
  'retry_pending',
  'pr_created',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const providerNameSchema = z.enum(['claude', 'codex', 'github']);
export type ProviderName = z.infer<typeof providerNameSchema>;

export interface PlanStep {
  order: number;
  description: string;
  files: string[];
}

export interface TaskPlan {
  summary: string;
  steps: PlanStep[];
  risks: string[];
  filesExpectedToChange: string[];
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor' | 'info';
  file: string | null;
  summary: string;
}

export interface ReviewResult {
  reviewer: ProviderName;
  approved: boolean;
  findings: ReviewFinding[];
  raw: string;
}

export interface VerifyCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  passed: boolean;
}

export interface VerifyResult {
  passed: boolean;
  commands: VerifyCommandResult[];
}

export interface TaskAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  worktreePath: string | null;
  branchName: string | null;
  plan: TaskPlan | null;
  planValidation: { approved: boolean; reasons: string[] } | null;
  review: ReviewResult | null;
  secondaryReview: ReviewResult | null;
  verify: VerifyResult | null;
  failureReason: string | null;
}

export interface TaskState {
  contract: TaskContract;
  phase: TaskPhase;
  createdAt: string;
  updatedAt: string;
  attempts: TaskAttempt[];
  prUrl: string | null;
  cancelled: boolean;
  dryRun: boolean;
}

export interface ProviderInvocationResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface DoctorReport {
  provider: ProviderName;
  available: boolean;
  version: string | null;
  detail: string;
}
