# AGENTS.md — nokto-agent-orchestrator

Provider-uavhengige instruksjoner for KI-agenter (Claude Code, Codex, Gemini, Copilot).
Organisasjonsstandarden gjelder alltid og ligger ett sted:
**[nokto-ops/system/agent-standard.md](https://github.com/noktohq/nokto-ops/blob/main/system/agent-standard.md)**.
Denne filen inneholder bare det som er spesifikt for dette repoet.

## Dette repoet

Agentisk kodeleveranse: plan → validering → isolert worktree → implementering → gjennomgang → verifisering → PR. Merger aldri.

Rolle i organisasjonen: `produkt`. Standardgren: `main`. Register: `services.yaml` i nokto-ops.

## Før arbeid

1. Les `STATE.yaml` (NOW / NEXT / BLOCKED / siste checkpoint).
2. Verifiser gren og faktisk git-status (`git status`, `git log -1`).
3. Les README.md og eventuell RUNBOOK.md/STATUS.md før du endrer noe.

## Tester

Vitest (sikkerhet, providere, orkestrering). pnpm audit og gitleaks i CI.

## Etter arbeid

1. Kjør repoets tester/lint.
2. Oppdater `STATE.yaml` med checkpoint (`nokto stop --next "…"` fra nokto-ops, eller rediger for hånd etter schemaet).
3. Oppdater README/RUNBOOK dersom virkeligheten har endret seg.
4. Branch + pull request. Aldri push direkte til `main`.
