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
- **Scope enforcement is partial.** `scope.allowedPaths` /
  `scope.disallowedPaths` are validated against the plan's declared file
  list. The implementer's actual diff is not yet checked against that scope
  before review — an implementer that writes outside its declared paths is
  not currently blocked by a structural check. This is a known gap, not a
  documentation omission; do not rely on `allowedPaths` as a hard sandbox
  boundary against a misbehaving or compromised provider.

## Known limitations

- Diff-vs-`allowedPaths` enforcement described above is backlog, not
  implemented.
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
