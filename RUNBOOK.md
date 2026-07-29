# RUNBOOK — nokto-agent-orchestrator

## Helsesjekk

```bash
nokto-agent doctor
```

Rapporterer faktisk (ikke antatt) tilgjengelighet av `claude`, `codex` og GitHub-tilgang (`gh` CLI eller `GITHUB_TOKEN`). Kjør denne først ved enhver uventet feil — de fleste driftsproblemer er en manglende eller feilkonfigurert leverandør, ikke en bug i orkestratoren.

```bash
nokto-agent status                 # alle lagrede oppgaver og deres fase
nokto-agent status --task-id <id>  # full historikk: hvert forsøk, gjennomgang, feilårsak
```

## Vanlige feil

| Symptom                                                 | Sannsynlig årsak                                                                                             | Tiltak                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `doctor` viser `claude`/`codex` som `available: false`  | CLI ikke installert, eller ikke i `PATH`                                                                     | Installer CLI-en, eller sett `AGENT_CLAUDE_BIN`/`AGENT_CODEX_BIN` til full sti              |
| `NoImplementerAvailableError`                           | Ingen leverandør i kontraktens `allowedImplementers` er tilgjengelig                                         | Kjør `doctor`, installer manglende CLI, eller juster `allowedImplementers`                  |
| `phase: "failed"` rett etter planlegging                | Plan avvist av statisk sjekk eller LLM-validering                                                            | Se `attempts[0].planValidation.reasons` i `status`-output                                   |
| `phase: "completed"` men `prUrl: null`                  | `GITHUB_TOKEN` mangler, eller PR-opprettelse feilet (se auditlogg)                                           | Sett `GITHUB_TOKEN`, kjør `nokto-agent resume --task-id <id>`                               |
| `SecretsInDiffError` (auditlogg: `pr_creation_skipped`) | Diffen treffer et hemmelighetsmønster                                                                        | Se `audit/<id>.jsonl`, fjern hemmeligheten fra branchen manuelt — overstyr aldri skanningen |
| `CommandNotAllowedError` i verifiseringssteget          | En kommando i `testRequirements.commands` bruker en ikke-allowlistet binær eller en destruktiv git-operasjon | Bruk kun binærer fra `ALLOWED_BINARIES` i `src/security/allowlist.ts`                       |
| `WorktreeError: ... finnes allerede`                    | En tidligere kjøring krasjet midt i et forsøk og etterlot et worktree                                        | `git worktree list`, `git worktree remove --force <sti>`, `git worktree prune`              |
| Oppgave sitter fast i `retry_pending`                   | Ingen prosess har kalt `resume` etter den avbrutte kjøringen                                                 | `nokto-agent resume --task-id <id>`                                                         |

## Kansellering

```bash
nokto-agent cancel --task-id <id>
```

Setter `cancelled: true` på lagret tilstand. En pågående kjøring sjekker flagget mellom hvert steg (før hvert forsøk, før gjennomgang, før sekundær kontroll, før verifisering) og stopper med `phase: "cancelled"`. CLI-en er ikke en daemon — kansellering når kun en kjøring som aktivt poller samme `AGENT_ORCH_STATE_DIR` fra en annen prosess.

## Opprydding

Kjøretidsdata ligger utenfor git (`.gitignore`):

```bash
rm -rf .state      # lagret oppgavetilstand
rm -rf audit       # JSONL-auditlogger
rm -rf .worktrees  # git worktrees — foretrekk "git worktree remove" fremfor rm der mulig
```

Bruk `git worktree remove --force <sti>` fra repo-roten fremfor rå `rm -rf` på en worktree-mappe — det holder gits interne worktree-register konsistent.

## Kostnad

Hvert `claude -p`-kall (planlegging, validering, gjennomgang) og hvert `codex exec`-kall (implementering, sekundær kontroll) er et reelt, betalt API-kall. Sett `AGENT_CLAUDE_MAX_BUDGET_USD` for å begrense kostnad per Claude-kall. `constraints.maxRetries` og `constraints.timeoutMinutes` i oppgavekontrakten begrenser totalt antall kall og maks kjøretid per oppgave.

## Incident-håndtering

1. **Kjøring stopper uventet** — sjekk `status --task-id <id>` for siste `failureReason`, og `audit/<id>.jsonl` for full tidsstemplet hendelseshistorikk (hemmeligheter redigert).
2. **Mistanke om endring utenfor scope** — det feilede forsøkets worktree er allerede fjernet; sjekk `git branch --list 'agent/*'` for gjenværende branches og `git log <branch> --stat` for å se nøyaktig hva som ble committet før det ble forkastet.
3. **En PR ble åpnet med uønsket innhold** — lukk den på GitHub. Orkestratoren pusher aldri til `main` og merger aldri, så dette er alltid reversibelt uten å røre hovedbranchen.
4. **Rulle tilbake selve orkestratoren** — den skriver aldri utenfor sine egne worktrees under kjøring; `git revert` av commiten som introduserte den er trygt.
