[🇳🇴 Norsk](./README.no.md)

# nokto-agent-orchestrator

Orchestrates Claude Code, OpenAI Codex, and Google Gemini in a controlled delivery workflow for code changes submitted through pull requests.

Each task is planned, validated, implemented in an isolated Git worktree, reviewed independently, and verified against the task's own test commands. Changes are never merged automatically.

The system is built and used in production by [Nokto](https://nokto.no). Missing providers are reported as unavailable, failing tests stop the run, and model output that cannot be parsed is treated as an error.

## Workflow

1. **Planning**
   Claude creates an implementation plan with read-only access and without modifying files.

2. **Validation**
   The plan is checked using static controls for allowed paths, hard-blocked areas, and secrets. It can also be evaluated by a language model against custom quality profiles through `AGENT_PROFILE_FILES`.

3. **Isolation**
   A separate Git worktree is created from a new branch using the naming format `agent/<id>-<attempt>`. Agents never work directly in the main working copy.

4. **Implementation**
   Codex is the primary implementer, with Claude as the fallback. Permitted implementation agents are controlled by `allowedImplementers` in the task contract.

5. **Code review**
   The diff is reviewed independently by the first available provider in the task's `reviewers` list — Claude by default, with Gemini (through the Google GenAI SDK) as fallback when the Claude CLI is unavailable. The reviewer receives access only to the change itself, not the implementer's own summary.

6. **Secondary review**
   An additional review is performed when Claude implemented the change, or when the primary review identified material findings. The provider is the first available in `secondaryReviewers` — Codex in a read-only sandbox by default, with Gemini as fallback when the Codex CLI is not installed.

7. **Verification**
   The commands in `testRequirements.commands` are executed in the worktree through an explicit command allowlist.

8. **Correction**
   Verification failures and review findings are returned to the implementer as specific correction items.

9. **Re-review and verification**
   Steps 4–7 are repeated after corrections. The number of additional attempts is limited by `maxRetries`.

10. **Pull request**
    The diff is scanned for secrets, pushed, and opened as a pull request with a complete report containing the implementation plan, review findings, and verification results. The change must be merged by a human.

State is stored atomically after each step. An interrupted run can therefore resume from the exact last completed step.

All events are stored in an append-only JSONL audit log. Secrets are redacted before they are written to the log.

## Security

| Control                                                | Protection                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Argument-based process execution without `shell: true` | Prevents command injection structurally, without relying on text sanitization                            |
| Binary allowlist                                       | Restricts which tools agents can execute                                                                 |
| Git subcommand rules                                   | Blocks destructive or high-risk Git operations                                                           |
| Force-push blocking                                    | Rejects `--force` and `--force-with-lease`                                                               |
| Main branch protection                                 | Prevents direct pushes to `main`; changes are delivered only through pull requests                       |
| Worktree requirement                                   | Rejects mutating Git operations outside an isolated worktree                                             |
| Secret scanning                                        | Scans plans and diffs and blocks pull-request creation when secrets are detected                         |
| Audit-log redaction                                    | Removes secrets before events are stored                                                                 |
| Sandbox hard block                                     | Rejects the Codex `danger-full-access` configuration during loading, regardless of environment variables |
| Runtime environment verification                       | `doctor` checks the actual binaries and never assumes that a provider or dependency is available         |

The following Git operations are always blocked:

```text
git reset
git clean
git filter-branch
git filter-repo
git checkout -- <path>
```

Allowed binaries include:

```text
git
pnpm
npm
node
tsc
vitest
eslint
prettier
python3
pytest
```

## Requirements

- Node.js 20 or later
- pnpm 9
- [`claude` CLI](https://docs.claude.com/claude-code), installed and authenticated for planning and code review
- [`codex` CLI](https://developers.openai.com/codex), installed for implementation and secondary review
- `GEMINI_API_KEY` if Google Gemini should be available for code review and secondary review — called directly through the official [Google GenAI SDK](https://github.com/googleapis/js-genai) (`@google/genai`), with the model configurable through `GEMINI_MODEL` (default `gemini-3.5-flash`)
- `GITHUB_TOKEN` if the orchestrator should create pull requests automatically

Codex is optional. Claude can be used as the only implementer by specifying:

```yaml
allowedImplementers:
  - claude
```

Gemini is intentionally never used as an implementer: it is called through the API without a CLI sandbox and structurally cannot modify files. It participates in the review roles, where it only ever receives the diff text.

Check which providers and binaries are actually available in the environment:

```bash
nokto-agent doctor
```

`doctor` checks the real binaries and reports missing dependencies without assuming availability.

## Installation

### Local development

```bash
pnpm install
cp .env.example .env
pnpm run build
```

`.env.example` contains safe default values.

### Installation from GitHub with npm

```bash
npm install github:noktohq/nokto-agent-orchestrator
```

The `prepare` script builds the package automatically when installed directly from Git.

### Installation from GitHub with pnpm

```bash
pnpm add github:noktohq/nokto-agent-orchestrator
```

pnpm blocks build scripts for Git dependencies by default. This is a pnpm security measure and must be approved explicitly.

Add the package to `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - nokto-agent-orchestrator
```

Then approve the build script:

```bash
pnpm approve-builds
```

The repository is public on GitHub. The `"private": true` setting in `package.json` only prevents accidental publication to npm and does not affect the repository's visibility.

## CLI

```bash
nokto-agent doctor
nokto-agent plan --task tasks/example.yaml
nokto-agent dry-run --task tasks/example.yaml
nokto-agent run --task tasks/example.yaml
nokto-agent status
nokto-agent status --task-id <id>
nokto-agent resume --task-id <id>
nokto-agent cancel --task-id <id>
nokto-agent review --task <file> --worktree <dir>
nokto-agent verify --task <file> --worktree <dir>
```

The commands are used as follows:

| Command                 | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `doctor`                | Checks which providers and binaries are available                                        |
| `plan`                  | Creates an implementation plan without modifying files                                   |
| `dry-run`               | Plans, validates, and creates a worktree without implementation or pull-request creation |
| `run`                   | Runs the complete delivery workflow                                                      |
| `status`                | Displays all stored tasks                                                                |
| `status --task-id <id>` | Displays the complete history of one task                                                |
| `resume`                | Resumes an interrupted task                                                              |
| `cancel`                | Cancels an active task                                                                   |
| `review`                | Performs a standalone code review                                                        |
| `verify`                | Performs standalone verification                                                         |

Run the CLI directly from the source code during development:

```bash
pnpm run cli -- <command>
```

## MCP server

The following seven operations are exposed as MCP tools over stdio:

```text
agent_doctor
agent_plan_task
agent_run_task
agent_review_task
agent_get_status
agent_resume_task
agent_cancel_task
```

Start the built MCP server with:

```bash
node dist/mcp/server.js
```

Start the MCP server directly from the source code during development:

```bash
pnpm run mcp
```

## Task contract

Tasks are defined as YAML or JSON files and validated against a strict Zod schema in `src/types.ts`.

See `tasks/example.yaml` for a complete example.

| Field                             | Purpose                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `scope.allowedPaths`              | Glob patterns for files and directories agents are permitted to modify    |
| `scope.disallowedPaths`           | Glob patterns for files and directories that are always blocked           |
| `acceptanceCriteria`              | Requirements used to evaluate the implementation plan, review, and result |
| `testRequirements.commands`       | Commands executed through the allowlist during verification               |
| `constraints.maxRetries`          | Maximum number of correction attempts                                     |
| `constraints.timeoutMinutes`      | Maximum runtime for the task                                              |
| `constraints.allowedImplementers` | Implementation agents that may be used                                    |
| `constraints.reviewers`           | Review providers in order of preference (`claude`, `gemini`)              |
| `constraints.secondaryReviewers`  | Secondary-review providers in order of preference (`codex`, `gemini`)     |
| `git.baseBranch`                  | Branch from which the worktree is created                                 |
| `git.branchPrefix`                | Prefix used for task branches                                             |

Plans and file changes outside the permitted scope are rejected.

## Testing

Run the checks separately:

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
```

Run the complete validation chain:

```bash
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm run test && pnpm run build
```

The project has 95 tests.

The worktree-isolation and verification tests use real Git repositories in temporary directories, not mocks.

Provider adapters are tested with mocked process execution, and the Gemini adapter with a mocked SDK. The standard test suite therefore performs no paid API calls and requires no API keys.

A real integration test against `claude -p` is available through explicit opt-in:

```bash
RUN_LIVE_PROVIDER_TESTS=1
```

## Reproducible testing

Everything below runs offline from a fresh clone — no provider binaries, no API keys, and no paid calls:

```bash
git clone https://github.com/noktohq/nokto-agent-orchestrator.git
cd nokto-agent-orchestrator
pnpm install
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run build
```

`pnpm test` runs the vitest suite. All provider adapters — Claude, Codex, and Gemini — are tested against mocks, so the suite passes without any provider installed or any key set.

Check which providers are actually available in your environment:

```bash
pnpm run cli -- doctor
```

Each provider is reported independently and the orchestrator only uses what `doctor` finds. To run the example task with only some providers available:

- The minimum for `run` is the `claude` CLI: it covers planning, implementation, and primary review on its own.
- With `claude` plus `GEMINI_API_KEY`, Gemini performs the secondary review that would otherwise require the `codex` CLI.
- Without `GITHUB_TOKEN`, the run completes with phase `completed` instead of `pr_created` — pull-request creation is skipped, never simulated.

```bash
export GEMINI_API_KEY=...              # from Google AI Studio — never commit it
export GEMINI_MODEL=gemini-3.5-flash   # optional, this is the default
pnpm run cli -- run --task tasks/example.yaml
```

Environment variables for the Gemini provider:

| Variable                   | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `GEMINI_API_KEY`           | Enables the Gemini provider (code review and secondary review)                 |
| `GEMINI_MODEL`             | Gemini model id, default `gemini-3.5-flash` — exact model ids change over time |
| `AGENT_GEMINI_TIMEOUT_SEC` | Timeout in seconds per Gemini call, default 600                                |

## Cost control

Every call to `claude -p`, `codex exec`, and the Gemini API is a real invocation that may incur costs.

The following settings limit resource usage:

- `AGENT_CLAUDE_MAX_BUDGET_USD` limits the cost per Claude invocation
- `constraints.maxRetries` limits the number of implementation attempts
- `constraints.timeoutMinutes` limits the runtime of each task

The `total_cost_usd` value reported by Claude CLI is recorded for each invocation.

## Operations

See [RUNBOOK.md](RUNBOOK.md) for:

- health checks
- common failures
- troubleshooting
- cancellation
- cleanup
- incident handling

## License

MIT © 2026 Nokto — [nokto.no](https://nokto.no)
