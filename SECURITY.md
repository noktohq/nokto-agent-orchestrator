# Security policy

## Supported version

Security fixes are applied to the latest `main` branch only.

## Reporting

Report suspected vulnerabilities privately to `edin@nokto.no`. Do not open a
public issue for a security report. Do not include API keys, `GITHUB_TOKEN`
values, or client repository content in the report.

## Security model

The orchestrator delegates code changes to third-party AI providers (Claude
Code, OpenAI Codex, Google Gemini) and runs their output through structural
controls before a human ever sees a pull request. See the "Security" table
in [README.md](README.md) for the full control list (argument-based process
execution, binary allowlist, Git subcommand rules, force-push blocking, main
branch protection, worktree isolation, secret scanning, audit-log redaction,
Codex sandbox hard block, runtime provider verification).

Two boundaries worth calling out explicitly:

- **Changes are never merged automatically.** Every run ends in a pull
  request (or an earlier phase); a human always performs the merge.
- **Scope is enforced on the actual diff.** One path policy
  (`src/security/scope.ts`) is applied twice: to the plan's declared file list
  (`validator.ts`) and to what the implementer actually changed
  (`assertDiffWithinScope`). The diff check runs after every implementation
  attempt (before review, so also after each correction) and again right
  before push in `pr.ts`. See "Scope guard" below.
- **Pushes only reach agent branches.** See "Push guard" below.

## Scope guard

`assertDiffWithinScope(config, contract, worktree)` inspects the worktree with
read-only Git commands (`runCommand` with `readOnly`, `-c core.fsmonitor=false`,
`--no-ext-diff --no-textconv --no-renames -z`):

- committed changes: `git diff --name-only` and `--raw` from the base commit to
  `HEAD`;
- uncommitted changes to tracked files: the same from the base commit to the
  working tree;
- untracked, non-ignored files: `git ls-files --others --exclude-standard -z`.

The base is the commit the worktree was created from (`WorktreeHandle.baseSha`,
recorded by `createWorktree`), not `origin/<baseBranch>`: refs are shared
between worktrees, so the implementer could move that ref. `HEAD` must equal
the agent branch and must descend from the base commit.

Every changed path (renames count as delete + add, so both paths are checked;
deletions are checked too) is rejected when it is:

- unsafe: absolute, contains a backslash, `..` or `.` segment, an empty
  segment, a Windows drive or a control character;
- outside `scope.allowedPaths` or inside `scope.disallowedPaths`;
- hard-blocked, case-insensitively: `.git/**`, `**/.git/**`,
  `.github/workflows/**`, `**/.env`, `**/.env.*`, `**/config.json`,
  `.gitmodules` (exception: `**/.env.example`);
- a symlink (mode `120000`, or an untracked symlink);
- a submodule (mode `160000`) or an embedded Git repository;
- resolving outside the worktree (`realpath`, checked on the nearest existing
  parent for deleted paths).

It fails closed. A Git error, a timeout, output that is not `\0`-terminated or
is close to `runCommand`'s capture limit, `--raw` and `--name-only` that
disagree, or no changes at all throws `ScopeInspectionError`. A rule breach
throws `ScopeViolationError`. In the pipeline either one fails the task at
once: no review, no further attempts, no push. The event is written to the
audit log as `scope_violation` (with `stage` `after_implementation` or
`before_push` and the breached paths and rules); a passing check is logged as
`scope_check_passed`.

## Push guard

`assertPushAllowed` in `src/security/allowlist.ts` checks every `git push` the
orchestrator runs (including test commands from a task contract):

- protected branches: always `main` and `master`; in `pr.ts` also the
  contract's `git.baseBranch` and the repository's actual default branch from
  `git symbolic-ref refs/remotes/origin/HEAD`. Compared case-insensitively,
  whether written as `main`, `refs/heads/main`, `HEAD:main`,
  `HEAD:refs/heads/main` or `<sha>:refs/heads/main`;
- the target must be an explicit branch under the agent branch prefix
  (`contract.git.branchPrefix`, default `agent/`);
- blocked: force (`-f`, `--force*`, `+refspec`, combined short flags with `f`),
  deletion (`:branch`, `--delete`, `--prune`), `--all`, `--mirror`, `--tags`,
  pattern refspecs, non-branch refs (`refs/tags/…`), a push without an explicit
  refspec or with only `HEAD`, any remote other than `origin`, and unknown push
  options;
- Git global options are parsed, so `git -c … push` cannot hide the
  subcommand. `-C`, `--git-dir`, `--work-tree` and `-c` values outside a short
  allowlist (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, …) are
  rejected.

`pr.ts` pushes exactly the commit the scope guard checked:
`git -c core.hooksPath=/dev/null push --no-verify origin <sha>:refs/heads/<agent-branch>`.
The explicit destination matters: with a refspec without a destination, Git
applies `remote.origin.push` from the repository configuration, which the
implementer can change (verified with Git 2.43: `git push origin agent/x`
landed on `main`). Hooks are off so a hook written by the implementer does not
run with the orchestrator's credentials.

Chosen variant: when `origin/HEAD` cannot be read at push time, the push is
not stopped. The prefix requirement is the strictest rule and already keeps
every branch outside the agent prefix out of reach, including an unknown
default branch. Without an explicit policy (for example test commands), the
default is `main`/`master` protected and prefix `agent/`.

## Known limitations

- The scope guard checks paths, not content. Review and secret scanning
  still cover what is inside the allowed files.
- An implementer with Git access in its worktree can change the shared
  repository configuration (for example `remote.origin.url` or credential
  helpers). The push guard pins the destination ref, not the remote URL.
- The secret scan before push and the reviewer diff still use
  `origin/<baseBranch>...HEAD`, not the recorded base commit.
- Generated files that are neither committed nor ignored (for example test
  output) fail the check before push, even though only commits are pushed.
- `pnpm audit --prod` currently reports 2 moderate advisories in the
  transitive `qs` dependency (via `@google/genai` →
  `@modelcontextprotocol/sdk` → `express`). CI's security job only fails on
  `--audit-level=high`, so these do not block merges. Track upstream fixes in
  `@google/genai`/`@modelcontextprotocol/sdk` rather than pinning `qs`
  directly, since it is not a direct dependency.
- Gemini is called over the network via `@google/genai` with no CLI sandbox;
  it is restricted to review roles and only ever receives diff text, never
  file-write access.
