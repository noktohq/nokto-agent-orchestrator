[🇳🇴 Norsk](./RUNBOOK.no.md)

# RUNBOOK — nokto-agent-orchestrator

## Health check

```bash
nokto-agent doctor
```

Reports the actual (not assumed) availability of `claude`, `codex`, and GitHub access (`gh` CLI or `GITHUB_TOKEN`). Run this first for any unexpected failure — most operational problems are a missing or misconfigured provider, not a bug in the orchestrator.

```bash
nokto-agent status                 # all stored tasks and their phase
nokto-agent status --task-id <id>  # full history: every attempt, review, failure reason
```

## Common failures

| Symptom                                                 | Likely cause                                                                                          | Action                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `doctor` shows `claude`/`codex` as `available: false`   | CLI not installed, or not on `PATH`                                                                   | Install the CLI, or set `AGENT_CLAUDE_BIN`/`AGENT_CODEX_BIN` to the full path                |
| `NoImplementerAvailableError`                           | No provider in the contract's `allowedImplementers` is available                                      | Run `doctor`, install the missing CLI, or adjust `allowedImplementers`                       |
| `phase: "failed"` right after planning                  | Plan rejected by static checks or LLM validation                                                      | See `attempts[0].planValidation.reasons` in `status` output                                  |
| `phase: "completed"` but `prUrl: null`                  | `GITHUB_TOKEN` missing, or PR creation failed (see audit log)                                         | Set `GITHUB_TOKEN`, run `nokto-agent resume --task-id <id>`                                  |
| `SecretsInDiffError` (audit log: `pr_creation_skipped`) | The diff matched a secret pattern                                                                     | See `audit/<id>.jsonl`, remove the secret from the branch manually — never override the scan |
| `CommandNotAllowedError` during verification            | A command in `testRequirements.commands` uses a non-allowlisted binary or a destructive git operation | Use only binaries from `ALLOWED_BINARIES` in `src/security/allowlist.ts`                     |
| `WorktreeError: ... already exists`                     | A previous run crashed mid-attempt and left a worktree behind                                         | `git worktree list`, `git worktree remove --force <path>`, `git worktree prune`              |
| Task stuck in `retry_pending`                           | No process has called `resume` after the interrupted run                                              | `nokto-agent resume --task-id <id>`                                                          |

## Cancellation

```bash
nokto-agent cancel --task-id <id>
```

Sets `cancelled: true` on the stored state. A running task checks the flag between each step (before every attempt, before review, before secondary review, before verification) and stops with `phase: "cancelled"`. The CLI is not a daemon — cancellation only reaches a run that is actively polling the same `AGENT_ORCH_STATE_DIR` from another process.

## Cleanup

Runtime data lives outside git (`.gitignore`):

```bash
rm -rf .state      # stored task state
rm -rf audit       # JSONL audit logs
rm -rf .worktrees  # git worktrees — prefer "git worktree remove" over rm where possible
```

Use `git worktree remove --force <path>` from the repo root instead of a raw `rm -rf` on a worktree directory — it keeps git's internal worktree registry consistent.

## Cost

Every `claude -p` call (planning, validation, review) and every `codex exec` call (implementation, secondary review) is a real, paid API call. Set `AGENT_CLAUDE_MAX_BUDGET_USD` to limit cost per Claude call. `constraints.maxRetries` and `constraints.timeoutMinutes` in the task contract limit the total number of calls and the maximum runtime per task.

## Incident handling

1. **A run stops unexpectedly** — check `status --task-id <id>` for the last `failureReason`, and `audit/<id>.jsonl` for the full timestamped event history (secrets redacted).
2. **Suspected out-of-scope change** — the failed attempt's worktree has already been removed; check `git branch --list 'agent/*'` for remaining branches and `git log <branch> --stat` to see exactly what was committed before it was discarded.
3. **A PR was opened with unwanted content** — close it on GitHub. The orchestrator never pushes to `main` and never merges, so this is always reversible without touching the main branch.
4. **Rolling back the orchestrator itself** — it never writes outside its own worktrees during a run; `git revert` of the commit that introduced it is safe.
