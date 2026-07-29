# nokto-agent-orchestrator

AI-agenter som leverer kode via pull request — med sikkerhetsgrepene de fleste agent-rammeverk hopper over.

Orkestrerer Claude Code (planlegger, kodegjennomgang) og OpenAI Codex (implementerer, sekundær kontroll) gjennom en 10-stegs leveranseflyt: hver endring planlegges, valideres, implementeres i en isolert git worktree, gjennomgås uavhengig, verifiseres mot oppgavens egne testkommandoer, og leveres som pull request. Aldri automatisk merge.

Bygget og brukt i produksjon av [Nokto](https://nokto.no). Ingen simulert suksess noe sted: manglende leverandører rapporteres som manglende, feilende tester feiler kjøringen, og uparserbar modell-output behandles som feil — ikke stille akseptert.

## Arbeidsflyt

1. **Plan** — Claude lager en implementeringsplan (kun lesetilgang, ingen filendringer).
2. **Valider** — statiske sjekker (sti-scope, hardblokkerte stier, hemmelighetsskann) pluss valgfri LLM-vurdering av planen mot dine egne kvalitetsprofiler (`AGENT_PROFILE_FILES`).
3. **Isoler** — `git worktree add` på en fersk `agent/<id>-<forsøk>`-branch. Agenter rører aldri hovedarbeidskopien.
4. **Implementer** — Codex (primær) eller Claude (fallback), styrt av oppgavekontraktens `allowedImplementers`.
5. **Gjennomgå** — Claude gjennomgår diffen uavhengig. Den ser kun diffen, ikke implementererens egen oppsummering.
6. **Sekundær kontroll** — Codex (read-only sandbox) når Claude implementerte, eller når primærgjennomgangen fant vesentlige funn.
7. **Verifiser** — oppgavekontraktens egne `testRequirements.commands` kjøres i worktreet, gjennom kommando-allowlisten.

Steg 8–9 (**prøv på nytt**): feil sendes tilbake til implementereren som konkrete funn, og steg 4–7 gjentas, begrenset av `maxRetries`.

10. **Pull request** — diffen hemmelighetsskannes, pushes, og åpnes som PR med full rapport (plan, gjennomgangsfunn, verifiseringsresultat). Et menneske merger. Alltid.

Tilstand lagres etter hvert steg (atomisk skriving), så en avbrutt kjøring gjenopptas nøyaktig der den stoppet. Hver hendelse havner i en append-only JSONL-auditlogg med hemmeligheter redigert bort.

## Sikkerhetsmodellen

Dette er delen de fleste agent-rammeverk hopper over:

| Kontroll                                | Hva den hindrer                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Argv-only spawning, aldri `shell: true` | Kommandoinjeksjon — strukturelt, ikke ved sanitering                                                                            |
| Binær-allowlist                         | Agenter kan kun kjøre kjente verktøy (`git`, `pnpm`, `npm`, `node`, `tsc`, `vitest`, `eslint`, `prettier`, `python3`, `pytest`) |
| Git-subkommando-regler                  | `reset`, `clean`, `filter-branch`, `filter-repo`, `checkout -- <sti>` alltid blokkert                                           |
| Force-push-blokkering                   | `--force` / `--force-with-lease` aldri tillatt                                                                                  |
| Hovedbranch-beskyttelse                 | `git push` mot `main` aldri tillatt — kun PR                                                                                    |
| Repo-rot-beskyttelse                    | Muterende git-kommandoer nektes utenfor en isolert worktree                                                                     |
| Hemmelighetsskanning                    | Planer og differ skannes; treff hardblokkerer PR-opprettelse. Auditlogger redigeres                                             |
| Sandbox-hardblokk                       | Codex' `danger-full-access` kaster feil ved config-lasting, uansett miljøvariabel                                               |
| Ærlig deteksjon                         | `doctor` prober de ekte binærene — tilgjengelighet antas aldri                                                                  |

## Krav

- Node.js ≥ 20, pnpm 9
- [`claude` CLI](https://docs.claude.com/claude-code) installert og innlogget (planlegging/gjennomgang)
- [`codex` CLI](https://developers.openai.com/codex) installert (implementering/sekundær kontroll) — valgfritt; Claude kan være eneste implementerer via `allowedImplementers: [claude]`
- `GITHUB_TOKEN` for at orkestratoren skal kunne åpne pull requests selv

Kjør `nokto-agent doctor` for å se nøyaktig hva som er tilgjengelig i ditt miljø — den prober de ekte binærene og gjetter aldri.

## Installasjon

```bash
pnpm install
cp .env.example .env   # alt har trygge standardverdier
pnpm run build
```

## Bruk

```bash
nokto-agent doctor                            # hva er faktisk tilgjengelig?
nokto-agent plan --task tasks/example.yaml     # kun planlegging, ingen endringer
nokto-agent dry-run --task tasks/example.yaml  # plan + valider + worktree, ingen implementering/PR
nokto-agent run --task tasks/example.yaml      # hele arbeidsflyten
nokto-agent status                             # alle lagrede oppgaver
nokto-agent status --task-id <id>              # full historikk for én oppgave
nokto-agent resume --task-id <id>              # gjenoppta en avbrutt kjøring
nokto-agent cancel --task-id <id>              # kanseller en pågående oppgave
nokto-agent review --task <fil> --worktree <dir>  # frittstående gjennomgang
nokto-agent verify --task <fil> --worktree <dir>  # frittstående verifisering
```

Under utvikling, uten bygg: `pnpm run cli -- <kommando> ...`

## MCP-server

De samme sju operasjonene eksponert som MCP-verktøy (`agent_doctor`, `agent_plan_task`, `agent_run_task`, `agent_review_task`, `agent_get_status`, `agent_resume_task`, `agent_cancel_task`) over stdio:

```bash
node dist/mcp/server.js   # eller: pnpm run mcp
```

## Oppgavekontrakter

En oppgave er en YAML-/JSON-fil validert mot et strengt Zod-skjema (`src/types.ts`). Se `tasks/example.yaml`. Nøkkelfelt:

| Felt                                                                | Betydning                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `scope.allowedPaths` / `disallowedPaths`                            | Glob-mønstre — planer og filendringer utenfor disse avvises      |
| `acceptanceCriteria`                                                | Hva planen og gjennomgangen vurderes mot                         |
| `testRequirements.commands`                                         | Kommandoer som kjøres i verifiseringssteget, gjennom allowlisten |
| `constraints.maxRetries` / `timeoutMinutes` / `allowedImplementers` | Grenser for kjøringen                                            |
| `git.baseBranch` / `branchPrefix`                                   | Hvor worktreet forgrenes fra, og branch-navngiving               |

## Testing

```bash
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm run test && pnpm run build
```

80 tester. Worktree-isolasjons- og verifiseringssuitene bruker ekte git-repositorier i midlertidige mapper — ikke mocks. Provider-adapterne testes med mocket prosesskjøring, så suiten gjør aldri betalte API-kall; én ekte `claude -p`-integrasjonstest finnes bak eksplisitt opt-in (`RUN_LIVE_PROVIDER_TESTS=1`).

## Kostnad

Hvert `claude -p`- og `codex exec`-kall er et reelt, betalt API-kall. `AGENT_CLAUDE_MAX_BUDGET_USD` begrenser kostnad per Claude-kall; `maxRetries` og `timeoutMinutes` i oppgavekontrakten begrenser hver kjøring. `claude`-CLI-ens egen rapporterte `total_cost_usd` fanges per kall.

## Drift

Se [RUNBOOK.md](RUNBOOK.md) — helsesjekk, vanlige feil, kansellering, opprydding, incident-håndtering.

## Lisens

MIT © 2026 Nokto — [nokto.no](https://nokto.no)
