import { AuditLog } from '../audit.js';
import { planTask } from './planner.js';
import { validatePlan } from './validator.js';
import {
  createWorktree,
  deleteLocalBranch,
  removeWorktree,
  type WorktreeHandle,
} from './worktree.js';
import { implementTask } from './implementer.js';
import { reviewCode, reviewHasBlockers } from './reviewer.js';
import { needsSecondaryReview, secondaryReviewCode } from './secondaryReviewer.js';
import { runVerify } from './verifier.js';
import { createTaskPullRequest } from './pr.js';
import { TaskStore } from './taskStore.js';
import {
  assertDiffWithinScope,
  ScopeInspectionError,
  ScopeViolationError,
} from '../security/scope.js';
import {
  assertGitConfigUnchanged,
  gitConfigDigest,
  GitIntegrityError,
} from '../security/gitIntegrity.js';
import type { OrchestratorConfig } from '../config.js';
import type {
  ReviewResult,
  TaskAttempt,
  TaskContract,
  TaskPhase,
  TaskState,
  TaskPlan,
  VerifyResult,
} from '../types.js';

export class TaskCancelledError extends Error {}

/**
 * Scope-vakten stoppet oppgaven. Ikke et vanlig mislykket forsøk: en implementerer
 * som skriver utenfor scope får ikke nye forsøk, og ingenting pushes.
 */
class ScopeAbortError extends Error {}

type GuardError = ScopeViolationError | ScopeInspectionError | GitIntegrityError;

function isScopeError(err: unknown): err is GuardError {
  return (
    err instanceof ScopeViolationError ||
    err instanceof ScopeInspectionError ||
    err instanceof GitIntegrityError
  );
}

function scopeAuditData(err: GuardError): Record<string, unknown> {
  return {
    error: err.name,
    reason: err.message,
    violations:
      err instanceof ScopeViolationError
        ? err.violations.map((v) => ({ path: v.path, rule: v.rule }))
        : [],
  };
}

export interface RunTaskOptions {
  /** Kjør alt fram til (men ikke inkludert) faktisk implementering — verifiserer at
   * planlegging, validering og worktree-oppsett fungerer, uten å bruke en implementerings-agent
   * eller opprette PR. Brukes av CLI-kommandoen "dry-run". */
  dryRun?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newAttempt(
  attempt: number,
  plan: TaskPlan,
  planValidation: { approved: boolean; reasons: string[] }
): TaskAttempt {
  return {
    attempt,
    startedAt: nowIso(),
    finishedAt: null,
    worktreePath: null,
    branchName: null,
    plan,
    planValidation,
    review: null,
    secondaryReview: null,
    verify: null,
    failureReason: null,
  };
}

function buildFailureReason(
  implementerFailure: string | null,
  review: ReviewResult | null,
  secondaryReview: ReviewResult | null,
  verify: VerifyResult | null
): string {
  const parts: string[] = [];
  if (implementerFailure) parts.push(`Implementering: ${implementerFailure}`);
  if (review && (!review.approved || reviewHasBlockers(review))) {
    const blockers = review.findings.filter(
      (f) => f.severity === 'blocker' || f.severity === 'major'
    );
    parts.push(
      `Kodegjennomgang avvist: ${blockers.map((f) => `[${f.severity}] ${f.file ?? ''} ${f.summary}`).join(' | ') || 'ingen detaljer'}`
    );
  }
  if (secondaryReview && (!secondaryReview.approved || reviewHasBlockers(secondaryReview))) {
    const blockers = secondaryReview.findings.filter(
      (f) => f.severity === 'blocker' || f.severity === 'major'
    );
    parts.push(
      `Sekundær kontroll avvist: ${blockers.map((f) => `[${f.severity}] ${f.file ?? ''} ${f.summary}`).join(' | ') || 'ingen detaljer'}`
    );
  }
  if (verify && !verify.passed) {
    const failed = verify.commands.filter((c) => !c.passed);
    parts.push(
      `Verifisering feilet: ${failed.map((c) => `"${c.command}" (exit ${c.exitCode})`).join(', ')}`
    );
  }
  return parts.join('\n') || 'Ukjent feil.';
}

/**
 * Slår sammen en eventuell kanselleringsflagg satt av en ANNEN prosess (f.eks.
 * CLI-kommandoen "cancel" som skriver rett til disk) inn i det pågående
 * kjøringens minne-state, FØR vi lagrer. Uten dette ville en vanlig
 * store.save(state) her — som alltid skriver hele det in-memory state-objektet
 * — kunne overskrive og dermed miste en kansellering satt utenfra mellom to
 * lagringer.
 */
function syncCancelledFromDisk(store: TaskStore, state: TaskState): void {
  if (!store.exists(state.contract.id)) return;
  const onDisk = store.load(state.contract.id);
  if (onDisk.cancelled) {
    state.cancelled = true;
  }
}

/** Lagrer status, men mister aldri en kansellering satt utenfra (se syncCancelledFromDisk). */
function persist(store: TaskStore, state: TaskState): void {
  syncCancelledFromDisk(store, state);
  store.save(state);
}

/** Synker og kaster TaskCancelledError dersom oppgaven er kansellert — av denne eller en annen prosess. */
function checkCancelled(store: TaskStore, state: TaskState): void {
  syncCancelledFromDisk(store, state);
  if (state.cancelled) {
    throw new TaskCancelledError(`Oppgave "${state.contract.id}" ble kansellert.`);
  }
}

export interface RunTaskDeps {
  config: OrchestratorConfig;
  store: TaskStore;
}

/**
 * Kjører hele 10-stegs arbeidsflyten for én oppgavekontrakt: planlegging →
 * validering → (implementering → gjennomgang → sekundær kontroll →
 * verifisering)* med begrenset antall forsøk → PR. Status lagres til disk
 * (TaskStore) og hendelser logges (AuditLog) etter hvert steg, slik at en
 * avbrutt kjøring kan gjenopptas med `resumeTask`.
 */
export async function runTask(
  deps: RunTaskDeps,
  contract: TaskContract,
  opts: RunTaskOptions = {},
  resumeState?: TaskState
): Promise<TaskState> {
  const { config, store } = deps;
  const audit = new AuditLog(config.auditDir, contract.id);

  const state: TaskState = resumeState ?? {
    contract,
    phase: 'created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    attempts: [],
    prUrl: null,
    cancelled: false,
    dryRun: opts.dryRun ?? false,
  };

  const setPhase = (phase: TaskPhase): void => {
    state.phase = phase;
    state.updatedAt = nowIso();
    persist(store, state);
    audit.record('phase_changed', contract.id, { phase });
  };

  try {
    let plan: TaskPlan;
    let planValidation: { approved: boolean; reasons: string[] };

    const lastAttemptWithPlan = state.attempts.at(-1);
    if (lastAttemptWithPlan?.plan && lastAttemptWithPlan.planValidation?.approved) {
      plan = lastAttemptWithPlan.plan;
      planValidation = lastAttemptWithPlan.planValidation;
      audit.record('plan_reused_on_resume', contract.id, {});
    } else {
      setPhase('planning');
      plan = await planTask(config, contract);
      audit.record('plan_created', contract.id, {
        summary: plan.summary,
        steps: plan.steps.length,
      });

      checkCancelled(store, state);
      planValidation = await validatePlan(config, contract, plan);
      audit.record('plan_validated', contract.id, {
        approved: planValidation.approved,
        reasons: planValidation.reasons,
      });

      if (!planValidation.approved) {
        setPhase('failed');
        audit.record('task_failed', contract.id, {
          reason: `Plan avvist: ${planValidation.reasons.join('; ')}`,
        });
        return state;
      }
      setPhase('plan_validated');
    }

    // Fingeravtrykk av git-konfigurasjonen før noen agent kjører i denne oppgaven. Låses
    // i state, så et resume ikke tar et nytt avtrykk av konfig agenten kan ha endret.
    state.security = state.security ?? {};
    if (state.security.gitConfigDigest === undefined) {
      state.security.gitConfigDigest = await gitConfigDigest(config);
      persist(store, state);
    }
    const configDigest = state.security.gitConfigDigest;

    const maxAttempts = contract.constraints.maxRetries + 1;
    let feedback: string | undefined;
    let succeeded = false;
    let successAttempt: TaskAttempt | null = null;
    let successWorktree: WorktreeHandle | null = null;

    for (let attemptNum = state.attempts.length + 1; attemptNum <= maxAttempts; attemptNum++) {
      checkCancelled(store, state);

      const attempt = newAttempt(attemptNum, plan, planValidation);
      state.attempts.push(attempt);
      setPhase('implementing');
      audit.record('attempt_started', contract.id, { attempt: attemptNum });

      // Agenten i et tidligere forsøk kan ha endret delt git-konfig (remote, fetch-refspec,
      // hooks, filter-drivere). Da kjøres ingen flere git-kall for oppgaven.
      try {
        await assertGitConfigUnchanged(config, configDigest);
      } catch (err) {
        if (!(err instanceof GitIntegrityError)) throw err;
        attempt.failureReason = `Git-integritet: ${err.message}`.slice(0, 4000);
        attempt.finishedAt = nowIso();
        audit.record('scope_violation', contract.id, {
          attempt: attemptNum,
          stage: 'before_worktree',
          ...scopeAuditData(err),
        });
        setPhase('failed');
        audit.record('task_failed', contract.id, { reason: attempt.failureReason });
        return state;
      }

      let worktree: WorktreeHandle;
      try {
        const lockedBase = state.security.baseSha;
        worktree = await createWorktree(
          config,
          contract.id,
          attemptNum,
          contract.git.branchPrefix,
          contract.git.baseBranch,
          lockedBase !== undefined ? { baseSha: lockedBase } : {}
        );
        if (lockedBase === undefined && worktree.baseSha !== undefined) {
          state.security.baseSha = worktree.baseSha;
        }
      } catch (err) {
        attempt.failureReason = `Worktree-opprettelse feilet: ${message(err)}`;
        attempt.finishedAt = nowIso();
        audit.record('worktree_failed', contract.id, { reason: attempt.failureReason });
        persist(store, state);
        continue;
      }
      attempt.worktreePath = worktree.path;
      attempt.branchName = worktree.branch;
      audit.record('worktree_created', contract.id, {
        path: worktree.path,
        branch: worktree.branch,
      });
      persist(store, state);

      if (opts.dryRun) {
        attempt.finishedAt = nowIso();
        audit.record('dry_run_stub', contract.id, {
          note: 'Stoppet før implementering — kun planlegging/validering/worktree testet.',
        });
        await removeWorktree(config, worktree).catch(() => undefined);
        await deleteLocalBranch(config, worktree.branch).catch(() => undefined);
        setPhase('completed');
        return state;
      }

      let review: ReviewResult | null = null;
      let secondaryReview: ReviewResult | null = null;
      let verify: VerifyResult | null = null;
      let implFailure: string | null = null;

      try {
        const implResult = await implementTask(config, contract, plan, worktree.path, feedback);
        audit.record('implementation_finished', contract.id, {
          implementer: implResult.implementer,
          ok: implResult.ok,
        });

        if (!implResult.ok) {
          implFailure =
            `${implResult.implementer}: ${implResult.stderrTail || implResult.summary || 'ukjent feil'}`.slice(
              0,
              2000
            );
        } else {
          // Scope-vakt: den faktiske diffen (ikke planen) mot allowedPaths/disallowedPaths
          // før noen gjennomgang. Kjøres for hvert forsøk, også etter korrigeringer.
          try {
            const scope = await assertDiffWithinScope(config, contract, worktree);
            audit.record('scope_check_passed', contract.id, {
              attempt: attemptNum,
              files: scope.files.length,
            });
          } catch (err) {
            if (!isScopeError(err)) throw err;
            audit.record('scope_violation', contract.id, {
              attempt: attemptNum,
              stage: 'after_implementation',
              ...scopeAuditData(err),
            });
            throw new ScopeAbortError(`Scope-vakt: ${err.message}`);
          }

          checkCancelled(store, state);
          setPhase('reviewing');
          review = await reviewCode(config, contract, plan, worktree.path, worktree.baseSha);
          attempt.review = review;
          audit.record('review_finished', contract.id, {
            approved: review.approved,
            findings: review.findings.length,
          });

          if (needsSecondaryReview(implResult.implementer, review)) {
            checkCancelled(store, state);
            setPhase('secondary_review');
            secondaryReview = await secondaryReviewCode(
              config,
              contract,
              plan,
              worktree.path,
              worktree.baseSha
            );
            attempt.secondaryReview = secondaryReview;
            if (secondaryReview) {
              audit.record('secondary_review_finished', contract.id, {
                approved: secondaryReview.approved,
                findings: secondaryReview.findings.length,
              });
            } else {
              audit.record('secondary_review_unavailable', contract.id, {});
            }
          }

          const reviewOk = review.approved && !reviewHasBlockers(review);
          const secondaryOk =
            !secondaryReview || (secondaryReview.approved && !reviewHasBlockers(secondaryReview));

          if (reviewOk && secondaryOk) {
            checkCancelled(store, state);
            setPhase('verifying');
            verify = await runVerify(config, contract, worktree.path);
            attempt.verify = verify;
            audit.record('verify_finished', contract.id, { passed: verify.passed });

            if (verify.passed) {
              attempt.finishedAt = nowIso();
              succeeded = true;
              successAttempt = attempt;
              successWorktree = worktree;
              persist(store, state);
              break;
            }
          }
        }
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err;
        if (err instanceof ScopeAbortError) {
          attempt.failureReason = err.message.slice(0, 4000);
          attempt.finishedAt = nowIso();
          await removeWorktree(config, worktree).catch(() => undefined);
          await deleteLocalBranch(config, worktree.branch).catch(() => undefined);
          setPhase('failed');
          audit.record('task_failed', contract.id, { reason: attempt.failureReason });
          return state;
        }
        implFailure = implFailure ?? message(err);
      }

      attempt.failureReason = buildFailureReason(implFailure, review, secondaryReview, verify);
      feedback = attempt.failureReason;
      attempt.finishedAt = nowIso();
      audit.record('attempt_failed', contract.id, {
        attempt: attemptNum,
        reason: attempt.failureReason,
      });

      await removeWorktree(config, worktree).catch(() => undefined);
      await deleteLocalBranch(config, worktree.branch).catch(() => undefined);

      if (attemptNum < maxAttempts) {
        setPhase('retry_pending');
      }
      persist(store, state);
    }

    if (!succeeded || !successAttempt || !successWorktree) {
      setPhase('failed');
      audit.record('task_failed', contract.id, {
        reason:
          state.attempts.at(-1)?.failureReason ??
          `Ingen forsøk lyktes innen ${maxAttempts} forsøk.`,
      });
      return state;
    }

    try {
      const pr = await createTaskPullRequest(
        config,
        contract,
        plan,
        successAttempt.review as ReviewResult,
        successAttempt.secondaryReview,
        successAttempt.verify as VerifyResult,
        successWorktree,
        { gitConfigDigest: configDigest }
      );
      state.prUrl = pr.htmlUrl;
      setPhase('pr_created');
      audit.record('pr_created', contract.id, { url: pr.htmlUrl, number: pr.number });
    } catch (err) {
      if (isScopeError(err)) {
        // Brudd oppdaget rett før push: ingenting er pushet, oppgaven feiler.
        successAttempt.failureReason = `Scope-vakt før push: ${err.message}`.slice(0, 4000);
        audit.record('scope_violation', contract.id, {
          attempt: successAttempt.attempt,
          stage: 'before_push',
          ...scopeAuditData(err),
        });
        await deleteLocalBranch(config, successWorktree.branch).catch(() => undefined);
        setPhase('failed');
        audit.record('task_failed', contract.id, { reason: successAttempt.failureReason });
      } else {
        setPhase('completed');
        audit.record('pr_creation_skipped', contract.id, { reason: message(err) });
      }
    } finally {
      await removeWorktree(config, successWorktree).catch(() => undefined);
    }

    return state;
  } catch (err) {
    if (err instanceof TaskCancelledError) {
      state.cancelled = true;
      setPhase('cancelled');
      audit.record('task_cancelled', contract.id, {});
      return state;
    }
    setPhase('failed');
    audit.record('task_failed', contract.id, { reason: message(err) });
    return state;
  }
}

const TERMINAL_PHASES = new Set<TaskPhase>(['completed', 'failed', 'cancelled', 'pr_created']);

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Gjenopptar en tidligere lagret oppgave — steg 1/2 hoppes over dersom en godkjent plan allerede finnes. */
export async function resumeTask(
  deps: RunTaskDeps,
  taskId: string,
  opts: RunTaskOptions = {}
): Promise<TaskState> {
  const state = deps.store.load(taskId);
  if (isTerminalPhase(state.phase) && !opts.dryRun) {
    return state;
  }
  state.cancelled = false;
  return runTask(deps, state.contract, opts, state);
}

/** Markerer en oppgave som kansellert. Selve kjøringen sjekker dette flagget mellom hvert steg. */
export function cancelTask(store: TaskStore, taskId: string): TaskState {
  const state = store.load(taskId);
  if (!isTerminalPhase(state.phase)) {
    state.cancelled = true;
    state.phase = 'cancelled';
    state.updatedAt = nowIso();
    store.save(state);
  }
  return state;
}
