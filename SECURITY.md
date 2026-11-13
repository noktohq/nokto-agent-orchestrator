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
read-only Git commands (`runCommand` with `readOnly`,
`-c core.fsmonitor=false -c core.hooksPath=/dev/null`,
`--no-ext-diff --no-textconv --no-renames --ignore-submodules=none --no-relative -z`).
Every call runs with `inspectionGitEnv()`: `GIT_NO_REPLACE_OBJECTS=1`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and no inherited `GIT_*`
variables. It checks:

- committed changes: `git diff --name-only` and `--raw` from the base commit to
  `HEAD`;
- every commit in `base..HEAD` on its own (`git rev-list --parents` +
  `git diff-tree -r -z --raw` against the parent), so a file that one commit
  adds and a later commit removes is still seen. Merge commits are rejected
  (`merge_commit`): the agent branch must be linear from the base. More than
  500 commits fails closed;
- uncommitted changes to tracked files: from the base commit to the working
  tree;
- untracked, non-ignored files: `git ls-files --others --exclude-standard -z`.

Before anything else it rejects a repository with `refs/replace/*` or
`info/grafts`: replace refs make `git diff` show a different tree than the one
`git push` sends (pack-objects ignores replacements), and grafts rewrite
ancestry and are not disabled by `GIT_NO_REPLACE_OBJECTS`.

The base is the commit the worktree was created from (`WorktreeHandle.baseSha`),
not `origin/<baseBranch>`: refs are shared between worktrees, so the
implementer could move that ref. `HEAD` must equal the agent branch and must
descend from the base commit.

Every changed path (renames count as delete + add; deletions are checked too)
is rejected when it is:

- unsafe: absolute, a backslash, `..` or `.` segment, an empty segment, a
  Windows drive, C0/C1 control characters, bidi controls, zero-width
  characters or BOM, invalid Unicode (lone surrogates, U+FFFD from non-UTF-8
  output), or not NFC-normalized;
- outside `scope.allowedPaths` (matched exactly) or inside
  `scope.disallowedPaths` (matched case-insensitively after NFKC folding, so
  `src/Secrets/k.ts` hits `src/secrets/**`);
- hard-blocked, case-insensitively after NFKC folding (`.github/workflowſ/`
  hits too): `.git/**`, `**/.git/**`, `**/.gitattributes`, `.gitmodules`,
  `**/.gitmodules`, all of `.github/**` (workflows, local actions, CODEOWNERS,
  dependabot), `CODEOWNERS`, `docs/CODEOWNERS`, `.husky/**`, `**/.npmrc`,
  `**/.env`, `**/*.env`, `**/.env.*`, `**/config.json` (exception:
  `**/.env.example`);
- a symlink (mode `120000`, or an untracked symlink);
- a submodule (mode `160000`) or an embedded Git repository;
- resolving outside the worktree (`realpath`, checked on the nearest existing
  parent for deleted paths).

In globs, `**/` matches whole path segments only: `docs/**/README.md` matches
`docs/README.md` and `docs/a/README.md`, not `docs/NOT_README.md`.

It fails closed. A Git error, a timeout, output that is not `\0`-terminated or
was truncated at `runCommand`'s capture limit (counted in bytes; output is
decoded once, so a multibyte character split across pipe chunks stays intact),
`--raw` and `--name-only` that disagree, or no changes at all throws
`ScopeInspectionError`. A rule breach throws `ScopeViolationError`. In the
pipeline either one fails the task at once: no review, no further attempts, no
push. The event is written to the audit log as `scope_violation` (with `stage`
`after_implementation`, `before_worktree` or `before_push`).

## Git integrity between attempts and before push

Refs, objects and `.git/config` are shared by all worktrees, and the
implementer runs as the same OS user as the orchestrator.
`src/security/gitIntegrity.ts` keeps it from steering the orchestrator's own
Git calls:

- **Base fetched with an orchestrator-owned refspec.** `createWorktree` runs
  `git fetch --no-tags origin +refs/heads/<base>:refs/nokto/base/<task>` and
  reads that ref. A changed `remote.origin.fetch` or a moved
  `refs/remotes/origin/<base>` does not affect it.
- **Base locked per task.** The first attempt's base commit is stored in
  `TaskState.security.baseSha` and reused by every later attempt and on
  resume; later attempts fetch nothing.
- **Config fingerprint.** Before the first attempt the pipeline stores a
  SHA-256 of the repository's shared `config` (+ `config.worktree`) and the
  user's global Git config (`TaskState.security.gitConfigDigest`). It is
  checked before every new worktree and right before push. Any change
  (`remote.origin.url/pushurl/push`, `url.*.insteadOf`, `credential.helper`,
  `core.sshCommand`, `http.*`, `filter.*`, `core.hooksPath` …) fails the task.
- **Base must be on the remote.** Right before push, `assertBaseOnRemote`
  fetches the remote base again (own refspec) and requires the locked base to
  be its ancestor. Everything reachable from the base is then already on the
  remote, so the push only carries commits in `base..HEAD`, which the scope
  guard checked one by one.
- **Hooks and fsmonitor off everywhere.** All orchestrator Git calls
  (`fetch`, `worktree add/remove/prune`, `branch -D`, `symbolic-ref`, diff,
  push) run with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- **Secret scan and review see what is pushed.** The scan before push reads
  `git log -p` for every commit in `<baseSha>..<headSha>`; the reviewers get
  `git diff <baseSha> HEAD`. Both use `--text --no-textconv --no-ext-diff
--no-renames --ignore-submodules=none` with replace objects off, so
  `* -diff` in `.gitattributes` or `.git/info/attributes` cannot turn content
  into "Binary files differ". Truncated or failed output stops the push.
- **No tokens for the agent.** The Claude and Codex CLIs and the verify
  commands (which run `package.json` scripts the agent may have written) get
  `agentEnv()`: no `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_*TOKEN`,
  `GEMINI_API_KEY`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `SSH_AUTH_SOCK` or `GIT_*`.
  The Claude implementer also gets `--disallowedTools` for `git push`,
  `git config`, `git remote`, `git update-ref`, `git replace`,
  `git symbolic-ref`, `git fetch`, `git worktree`, `git submodule`,
  `git filter-branch` and global options (`git -c`, `git -C`, `git --…`).

## Push guard

`assertPushAllowed` in `src/security/allowlist.ts` checks every `git push` the
orchestrator runs (including test commands from a task contract):

- every refspec must have exactly the form
  `<full commit id>:refs/heads/<agent prefix>…`, as `pr.ts` uses. A refspec
  without a colon is rejected (with `remote.origin.push` set, Git 2.43 sent
  `git push origin agent/x` to `main`), and so are symbolic sources (`HEAD`,
  branch names) and destinations without `refs/heads/` (Git would pick the
  ref type itself and could hit a tag on the remote);
- protected branches: always `main` and `master`; in `pr.ts` also the
  contract's `git.baseBranch` and the repository's actual default branch from
  `git symbolic-ref refs/remotes/origin/HEAD`, compared case-insensitively;
- the branch prefix must end with `/` (also enforced by the contract schema),
  so a prefix like `release` cannot admit `release-…`;
- blocked: force (`-f`, `--force*`, `+refspec`, combined short flags with `f`),
  deletion (`:branch`, `--delete`, `--prune`), `--all`, `--mirror`, `--tags`,
  pattern refspecs, a push without an explicit refspec, any remote other than
  `origin`, and unknown push options;
- Git global options are parsed, so `git -c … push` cannot hide the
  subcommand. `-C`, `--git-dir`, `--work-tree` and `-c` values outside a short
  allowlist (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, …) are
  rejected.

`pr.ts` pushes exactly the commit the scope guard checked:
`git -c core.hooksPath=/dev/null -c core.fsmonitor=false push --no-verify origin <sha>:refs/heads/<agent-branch>`.

Chosen variant: when `origin/HEAD` cannot be read at push time, the push is
not stopped. The prefix requirement already keeps every branch outside the
agent prefix out of reach. Without an explicit policy (for example test
commands), the default is `main`/`master` protected and prefix `agent/`.

## Known limitations

- **The push guard does not bound the agent process.** It checks the
  orchestrator's own `git push`. The implementer runs as the same OS user with
  `Bash(node *)` and `Bash(python3 *)`, so it can still write to `.git`, to
  `~/.gitconfig` or to credential stores on disk, and reach the network. The
  tokens in the orchestrator's environment are no longer passed to it, and the
  config fingerprint, locked base and remote-base check stop the orchestrator
  from acting on what it changed, but credentials stored outside the
  environment (for example `gh auth` files or an SSH key without a passphrase)
  remain reachable. Run the implementer as a separate OS user or in a
  container without push credentials for a hard boundary.
- The config fingerprint is taken when a task starts. Tampering left behind
  by an earlier task in the same repository is not detected.
- `info/attributes` and `.git/info/exclude` are not fingerprinted. Attributes
  cannot hide content from the scan (`--text`), and excludes only affect
  untracked files, which are never pushed.
- The scope guard checks paths, not content. Review and secret scanning
  still cover what is inside the allowed files. `package.json` scripts are not
  hard-blocked; the verify step runs them without tokens.
- Generated files that are neither committed nor ignored (for example test
  output) fail the check before push, even though only commits are pushed.
- Inspection calls ignore the global Git config. A repository that relies on
  `safe.directory` from global config (owned by another user) is expected to
  fail closed; this has not been tested.
- `pnpm audit --prod` reports no known vulnerabilities (verified
  2026-11-13). The full `pnpm audit` (including dev dependencies) reports one
  moderate advisory, GHSA-g3hv-75wg-m249, in `minimatch@10.2.6` via
  `@typescript-eslint/*`. Only `minimatch >=11.0.1` is patched, and the latest
  `@typescript-eslint` (8.72.2) still requires `minimatch ^10.2.2`, so it is
  left for an upstream fix instead of overriding a major version. It is a lint
  tool dependency and never ships in the runtime.
- Gemini is called over the network via `@google/genai` with no CLI sandbox;
  it is restricted to review roles and only ever receives diff text, never
  file-write access.
