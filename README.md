# nokto-agent-orchestrator

Orkestrerer Claude Code og OpenAI Codex i en kontrollert leveranseflyt for kodeendringer via pull request.

Hver oppgave planlegges, valideres, implementeres i en isolert Git-worktree, gjennomgås uavhengig og verifiseres mot oppgavens egne testkommandoer. Endringer merges aldri automatisk.

Løsningen er bygget og brukt i produksjon av [Nokto](https://nokto.no). Manglende leverandører rapporteres som utilgjengelige, feilende tester stopper kjøringen, og modelloutput som ikke kan parses, behandles som feil.

## Arbeidsflyt

1. **Planlegging**
   Claude utarbeider en implementeringsplan med kun lesetilgang og uten å endre filer.

2. **Validering**
   Planen kontrolleres med statiske sjekker for tillatte filstier, hardblokkerte områder og hemmeligheter. Den kan i tillegg vurderes av en språkmodell mot egendefinerte kvalitetsprofiler via `AGENT_PROFILE_FILES`.

3. **Isolering**
   Det opprettes en separat Git-worktree fra en ny branch med navneformatet `agent/<id>-<forsøk>`. Agentene arbeider aldri direkte i hovedarbeidskopien.

4. **Implementering**
   Codex er primær implementerer, med Claude som fallback. Tillatte implementeringsagenter styres av `allowedImplementers` i oppgavekontrakten.

5. **Kodegjennomgang**
   Claude gjennomgår diffen uavhengig og får kun tilgang til selve endringen, ikke implementererens egen oppsummering.

6. **Sekundær kontroll**
   Codex gjennomfører en ekstra kontroll i en skrivebeskyttet sandbox når Claude har implementert endringen, eller når den primære gjennomgangen har avdekket vesentlige funn.

7. **Verifisering**
   Kommandoene i `testRequirements.commands` kjøres i worktreet gjennom en eksplisitt kommando-allowlist.

8. **Korrigering**
   Verifiseringsfeil og gjennomgangsfunn sendes tilbake til implementereren som konkrete korrigeringspunkter.

9. **Ny gjennomgang og verifisering**
   Steg 4–7 gjentas etter korrigering. Antall nye forsøk begrenses av `maxRetries`.

10. **Pull request**
    Diffen hemmelighetsskannes, pushes og åpnes som pull request med en full rapport som inkluderer implementeringsplan, gjennomgangsfunn og verifiseringsresultater. Endringen må merges av et menneske.

Tilstanden lagres atomisk etter hvert steg. En avbrutt kjøring kan derfor gjenopptas fra nøyaktig siste fullførte steg.

Alle hendelser lagres i en append-only JSONL-auditlogg. Hemmeligheter redigeres før de skrives til loggen.

## Sikkerhet

| Kontroll                                      | Beskyttelse                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Argv-basert prosesskjøring uten `shell: true` | Hindrer kommandoinjeksjon strukturelt, uten å være avhengig av tekstsanitering                                  |
| Binær-allowlist                               | Begrenser hvilke verktøy agentene kan kjøre                                                                     |
| Git-subkommandoregler                         | Blokkerer destruktive eller risikable Git-operasjoner                                                           |
| Force-push-blokkering                         | Nekter `--force` og `--force-with-lease`                                                                        |
| Beskyttelse av hovedbranch                    | Hindrer direkte push til `main`; endringer leveres kun via pull request                                         |
| Worktree-krav                                 | Nekter muterende Git-operasjoner utenfor en isolert worktree                                                    |
| Hemmelighetsskanning                          | Skanner planer og differ og blokkerer opprettelse av pull request ved treff                                     |
| Redigering av auditlogger                     | Fjerner hemmeligheter før hendelser lagres                                                                      |
| Sandbox-hardblokkering                        | Avviser Codex-konfigurasjonen `danger-full-access` ved innlasting, uavhengig av miljøvariabler                  |
| Reell miljøkontroll                           | `doctor` kontrollerer de faktiske binærfilene og antar aldri at en leverandør eller avhengighet er tilgjengelig |

Følgende Git-operasjoner er alltid blokkert:

```text
git reset
git clean
git filter-branch
git filter-repo
git checkout -- <sti>
```

Tillatte binærfiler inkluderer:

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

## Krav

* Node.js 20 eller nyere
* pnpm 9
* [`claude` CLI](https://docs.claude.com/claude-code), installert og innlogget for planlegging og kodegjennomgang
* [`codex` CLI](https://developers.openai.com/codex), installert for implementering og sekundær kontroll
* `GITHUB_TOKEN` dersom orkestratoren skal opprette pull requests automatisk

Codex er valgfritt. Claude kan brukes som eneste implementerer ved å angi:

```yaml
allowedImplementers:
  - claude
```

Kontroller hvilke leverandører og binærfiler som faktisk er tilgjengelige i miljøet:

```bash
nokto-agent doctor
```

`doctor` undersøker de reelle binærfilene og rapporterer manglende avhengigheter uten å anta tilgjengelighet.

## Installasjon

### Lokal utvikling

```bash
pnpm install
cp .env.example .env
pnpm run build
```

`.env.example` inneholder trygge standardverdier.

### Installasjon fra GitHub med npm

```bash
npm install github:noktohq/nokto-agent-orchestrator
```

`prepare`-scriptet bygger pakken automatisk ved installasjon direkte fra Git.

### Installasjon fra GitHub med pnpm

```bash
pnpm add github:noktohq/nokto-agent-orchestrator
```

pnpm blokkerer byggescript for Git-avhengigheter som standard. Dette er et sikkerhetstiltak i pnpm og må godkjennes eksplisitt.

Legg pakken til i `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - nokto-agent-orchestrator
```

Godkjenn deretter byggescriptet:

```bash
pnpm approve-builds
```

Repoet er offentlig på GitHub. Innstillingen `"private": true` i `package.json` hindrer kun utilsiktet publisering til npm og påvirker ikke repoets synlighet.

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
nokto-agent review --task <fil> --worktree <dir>
nokto-agent verify --task <fil> --worktree <dir>
```

Kommandoene brukes slik:

| Kommando                | Formål                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `doctor`                | Kontrollerer hvilke leverandører og binærfiler som er tilgjengelige                |
| `plan`                  | Oppretter en implementeringsplan uten filendringer                                 |
| `dry-run`               | Planlegger, validerer og oppretter worktree uten implementering eller pull request |
| `run`                   | Kjører hele leveranseflyten                                                        |
| `status`                | Viser alle lagrede oppgaver                                                        |
| `status --task-id <id>` | Viser full historikk for én oppgave                                                |
| `resume`                | Gjenopptar en avbrutt oppgave                                                      |
| `cancel`                | Kansellerer en pågående oppgave                                                    |
| `review`                | Utfører en frittstående kodegjennomgang                                            |
| `verify`                | Utfører en frittstående verifisering                                               |

Kjør CLI direkte fra kildekoden under utvikling:

```bash
pnpm run cli -- <kommando>
```

## MCP-server

Følgende sju operasjoner eksponeres som MCP-verktøy over stdio:

```text
agent_doctor
agent_plan_task
agent_run_task
agent_review_task
agent_get_status
agent_resume_task
agent_cancel_task
```

Start den bygde MCP-serveren med:

```bash
node dist/mcp/server.js
```

Start MCP-serveren direkte fra kildekoden under utvikling:

```bash
pnpm run mcp
```

## Oppgavekontrakt

Oppgaver defineres som YAML- eller JSON-filer og valideres mot et strengt Zod-skjema i `src/types.ts`.

Se `tasks/example.yaml` for et komplett eksempel.

| Felt                              | Formål                                                                  |
| --------------------------------- | ----------------------------------------------------------------------- |
| `scope.allowedPaths`              | Glob-mønstre for filer og kataloger agentene har tillatelse til å endre |
| `scope.disallowedPaths`           | Glob-mønstre for filer og kataloger som alltid er blokkert              |
| `acceptanceCriteria`              | Krav implementeringsplanen, gjennomgangen og resultatet vurderes mot    |
| `testRequirements.commands`       | Kommandoer som kjøres gjennom allowlisten under verifisering            |
| `constraints.maxRetries`          | Maksimalt antall korrigeringsforsøk                                     |
| `constraints.timeoutMinutes`      | Maksimal kjøretid for oppgaven                                          |
| `constraints.allowedImplementers` | Implementeringsagenter som kan brukes                                   |
| `git.baseBranch`                  | Branchen worktreet opprettes fra                                        |
| `git.branchPrefix`                | Prefiks for oppgavebrancher                                             |

Planer og filendringer som faller utenfor tillatt scope, avvises.

## Testing

Kjør kontrollene separat:

```bash
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
```

Kjør hele kontrollkjeden samlet:

```bash
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm run test && pnpm run build
```

Prosjektet har 80 tester.

Testene for worktree-isolasjon og verifisering bruker ekte Git-repositorier i midlertidige kataloger, ikke mocks.

Provider-adapterne testes med mocket prosesskjøring. Den ordinære testsuiten utfører derfor ingen betalte API-kall.

En reell integrasjonstest mot `claude -p` finnes bak eksplisitt aktivering:

```bash
RUN_LIVE_PROVIDER_TESTS=1
```

## Kostnadskontroll

Hvert kall til `claude -p` og `codex exec` er et reelt kall som kan medføre kostnader.

Følgende innstillinger begrenser ressursbruk:

* `AGENT_CLAUDE_MAX_BUDGET_USD` begrenser kostnaden per Claude-kall
* `constraints.maxRetries` begrenser antall implementeringsforsøk
* `constraints.timeoutMinutes` begrenser kjøretiden per oppgave

Verdien `total_cost_usd`, rapportert av Claude CLI, registreres for hvert kall.

## Drift

Se [RUNBOOK.md](RUNBOOK.md) for:

* helsesjekk
* vanlige feil
* feilsøking
* kansellering
* opprydding
* hendelseshåndtering

## Lisens

MIT © 2026 Nokto — [nokto.no](https://nokto.no)
