# os-manager — v1 Implementation Plan

## Context

Frontier local coding agents (Claude Code, Codex CLI, and similar tools) are extremely capable but should not be given write authority over GitHub coordination. os-manager gives engineering teams a hierarchy: **one manager agent session** that triages, plans, and gates merges, while **many worker agent sessions** implement, and **a cheaper reviewer agent does the in-depth PR review which the manager meta-reviews**. Existing subagent-in-one-session approaches fail because enforcement is only prompt instructions (the orchestrator can "jailbreak" and code itself) and they don't scale to many agents or multiple humans. os-manager makes **GitHub itself the coordination substrate and the enforcement layer**.

Decisions locked with the user:
- **Form factor:** CLI daemon (`os-manager watch --repo org/repo`), TypeScript.
- **CLI-runner manager brain:** NOT direct provider API keys. The manager roles run through local coding-agent CLIs such as Claude Code (`claude --print`) or Codex CLI (`codex exec`) so auth, subscriptions, and model routing stay with those tools.
- **Hierarchical review:** a cheaper model performs the in-depth PR review; the frontier manager reviews that review (endorse / send back / override with commentary). The manager never does the deep review itself.
- **Workers:** bring-your-own-agent — any coding-agent session invokes an installed `work-on-issue` skill; the manager does not spawn workers in v1.
- **Enforcement:** GitHub-native — branch protection/ruleset + CODEOWNERS-required review from the manager's machine account + required `os-manager/approved` status check. Workers literally cannot merge.
- **Scope:** full lifecycle in v1: propose → triage → plan → claim → implement → review → meta-review → merge.

## Architectural stance (drives everything)

1. **GitHub labels are the database.** All lifecycle state derives from labels + assignees + review state. No authoritative local state; a daemon restart re-derives everything. Local files are disposable caches only (etags, budget counter, clones).
2. **The LLM judges; deterministic code acts.** LLM sessions run with a small read-only tool set and end with a structured JSON verdict. os-manager's TypeScript parses the verdict and performs every GitHub mutation. Gives idempotency, auditability, and prompt-injection containment — a malicious issue body can't trick a session into merging because the session *can't* mutate anything.
3. **No direct model API lock-in.** Every agent role (triage, plan, review, meta-review) is a `{provider, model, command?, args?}` CLI runner in config. Switching from Claude Code to Codex CLI is a config change, not an os-manager rewrite.
4. **Enforcement is GitHub-native**, never prompt-based.

## Package structure

Node 20+ ESM, `commander` (CLI), `@octokit/rest` + throttling plugin, local agent CLI runners (`claude --print`, `codex exec`), `yaml` + `zod` (config + verdict schemas), `tsup` (build, bin: `os-manager`), `vitest` (tests), `pino` (logs).

```
os-manager/
├── src/
│   ├── cli.ts                    # commander entry
│   ├── config.ts                 # zod-validated osmanager.yml + env
│   ├── commands/{init,watch,triage,plan,review,status,doctor}.ts
│   ├── github/
│   │   ├── client.ts             # makeOctokit(auth) — auth strategy pluggable (PAT now, App later)
│   │   ├── labels.ts             # LABELS const, ensureLabels(), applyTransition()
│   │   ├── state.ts              # deriveIssueState()/derivePrState() — pure fns, heavily tested
│   │   ├── markers.ts            # hidden HTML-comment markers (crash-recovery dedup)
│   │   └── rulesets.ts           # createRuleset(), verifyProtection(), CODEOWNERS gen
│   ├── llm/
│   │   ├── provider.ts           # build CLI invocations for claude-code / codex-cli runners
│   │   ├── session.ts            # runSession(): spawn local agent CLI, parse fenced-JSON verdicts,
│   │   │                         #   retry malformed output once, enforce command timeout/budget flags
│   │   └── tools.ts              # local read-only helper executors used by tests/future MCP wiring
│   ├── engine/
│   │   ├── loop.ts               # tick(): scan → build work items → dispatch
│   │   ├── scheduler.ts          # p-limit concurrency + per-item in-flight lock
│   │   └── budget.ts             # per-task + daily USD caps
│   ├── manager/
│   │   ├── triage.ts             # buildPrompt() + parseVerdict()
│   │   ├── plan.ts
│   │   ├── review.ts             # reviewer pass (cheap model) — the in-depth review
│   │   ├── metaReview.ts         # manager pass (frontier model) — judges the review
│   │   └── prompts.ts            # frozen system-prompt constants (prompt-cache friendly)
│   ├── workspace.ts              # clone per repo (~/.os-manager/workspaces/), PR worktrees
│   └── log.ts
├── assets/
│   ├── work-on-issue/SKILL.md    # worker skill, installed by `init`
│   └── osmanager.example.yml
├── test/{state,verdict,budget,loop,session}.test.ts + fixtures/
└── scripts/e2e.sh
```

## LLM layer (`src/llm/`) — the future-proofing core

- **`provider.ts`:** maps config `{provider: "claude-code"|"codex-cli", model?, command?, args?}` to a local CLI invocation. Claude Code uses `claude --print --safe-mode --permission-mode dontAsk --tools Read,Grep,Glob`; Codex CLI uses `codex exec --sandbox read-only --ask-for-approval never`.
- **`tools.ts`:** four local read-only helper executors with zod schemas: `read_file`, `glob`, `grep` (ripgrep), `git_read` (whitelisted subcommands only: `log`, `show`, `diff`, `blame`). These remain useful for tests and future MCP/server wiring, but the primary agent execution path is through the selected CLI.
- **`session.ts`:** `runSession({role, modelRef, system, prompt, cwd, budgetUsd})` — spawns the configured local agent CLI in the workspace; requires the final message to end with a fenced ```json block matching the role's zod verdict schema; one "your last message did not end with valid JSON" retry, then throw → `osm:escalated`.
- Local CLI sessions are bounded by `timeout_seconds`, CLI-native budget flags where available, and os-manager's review/meta-review round caps.

Verdict schemas — triage: `{verdict: "approve"|"reject", reasoning, commentMarkdown}`; plan: `{specMarkdown, estimatedSize, touchedAreas[]}`; review: `{verdict: "approve"|"request_changes", summaryMarkdown, comments: [{path,line,body}], specChecklist: [{item, met, note}]}`; meta-review: see below.

## Hierarchical review pipeline (per PR review round)

1. **Reviewer pass (strong model, e.g. `claude-opus-4-8`).** Full PR worktree at `refs/pull/N/head`, `git diff base...head` and the spec comment inlined; explores the checkout via tools. Produces the in-depth review verdict (above) including a spec-compliance checklist.
2. **Meta-review pass (frontier manager, e.g. `claude-fable-5`).** Input: the spec, the diff (stat + hunks), and the reviewer's full review. Cheap for the frontier model because it reads and judges rather than exploring the repo. Verdict:
   `{decision: "endorse"|"revise"|"override", commentary, revisionGuidance?, overrideVerdict?, additionalComments?: [{path,line,body}]}`
   - **endorse** → apply the reviewer's verdict + any `additionalComments`, with the manager's commentary in the review summary.
   - **revise** → re-run the reviewer pass with `revisionGuidance` appended ("you missed X; check Y against the spec"). Max `policies.max_meta_rounds` (default 2) per review round, then `osm:escalated`.
   - **override** → the manager's `overrideVerdict` + commentary is applied directly (bounded escape hatch; keeps the loop finite).
3. **Deterministic effects.** os-manager submits the final GitHub review (`APPROVE` or `REQUEST_CHANGES` with inline comments, summary crediting "reviewed by <reviewer-model>, approved by <manager-model>"), sets the `os-manager/approved` status on approve, then squash-merges.

Only the meta-review's outcome ever reaches GitHub — the reviewer's raw output is an internal artifact (logged, and attached to the marker comment for auditability).

## CLI commands

- `init --repo org/repo` — bootstrap (run with human admin's token): create `osm:*` labels; open a PR adding `.github/osmanager.yml`, `.claude/skills/work-on-issue/SKILL.md`, `CODEOWNERS`; create the ruleset; print any manual steps. Idempotent.
- `watch --repo org/repo [--interval 60] [--once] [--dry-run]` — the daemon. `--once` = single tick (cron/tests); `--dry-run` = print intended actions.
- `triage <issue>` / `plan <issue>` / `review <pr>` — one-shot versions of exactly the functions `watch` dispatches (one code path; `review` runs the full reviewer→meta-review pipeline).
- `status` — board view grouped by lifecycle state.
- `doctor` — verify token identity/scopes, labels, ruleset, CODEOWNERS, and configured local agent CLIs.

## State machine (labels, prefix `osm:` configurable)

Issue: `osm:proposed → osm:approved|osm:rejected(close) → osm:ready → osm:in-progress → osm:in-review → osm:done`, plus `osm:stale`, `osm:escalated`, `osm:human-override` (human pause switch — manager skips the item).
PR: `osm:awaiting-review → osm:changes-requested ⇄ osm:awaiting-review → osm:approved`.

Key transitions:
- New unlabeled issue → manager labels `osm:proposed`, triages → approve (comment + `osm:approved`) or reject (reasoned comment + close).
- `osm:approved` → manager posts spec comment with `<!-- osm:plan -->` marker (bug: root-cause analysis; feature: full spec) → `osm:ready`.
- Worker claims (assign + `osm:in-progress`), opens PR with `Closes #N` → `osm:in-review` / PR `osm:awaiting-review`.
- Review round (pipeline above) → APPROVE (+status check + squash-merge) or REQUEST_CHANGES with inline comments. Worker pushes + re-requests review → back in queue. New commits after review are also detected in the tick.
- `osm:in-progress` idle > `stale_after_hours` with no open PR → unassign, reset to `osm:ready`.
- Review rounds > `max_review_rounds` → `osm:escalated` + @-mention maintainers, manager stops touching it.

`src/github/state.ts`: `deriveIssueState(labels)` and `isLegalTransition(from, to)` as pure functions — the most unit-tested code in the repo.

## Event loop (`watch`)

**Polling (etag-conditional GETs), not webhooks, for v1** — runs on a laptop with no inbound network; 304s cost no rate limit; state-from-labels makes missed events harmless. Webhooks = v2 behind the same `tick()` interface.

Tick (default 60s): list open issues → enqueue triage (no `osm:*` label or `osm:proposed`) and plan (`osm:approved`); list open PRs → enqueue review (`osm:awaiting-review` or commits newer than the manager's last review). Hourly: stale sweep + budget-day rollover. Skip anything with `osm:human-override`; if daily budget exhausted, idle loudly.

**Idempotency:** (a) fresh label check immediately before acting; (b) every completed action leaves a hidden marker comment (e.g. `<!-- osm:triage {"verdict":"approve","v":1} -->`) so a crash between comment and label is repaired next tick without re-running the LLM. No local DB. Concurrency: `p-limit(2)` + per-item in-flight map; one watch process per repo (documented).

## Worker skill (`assets/work-on-issue/SKILL.md`)

Invoked with an issue URL/number. Protocol:
1. **Verify claimable:** label `osm:ready`, no `osm:in-progress`/`osm:human-override`, zero assignees; else abort with explanation.
2. **Claim:** `gh issue edit --add-assignee @me` → re-fetch → verify sole assignee (race: back off if another login appears) → post claim comment `<!-- osm:claim <login> <ISO> -->` (earlier-timestamp marker wins) → swap `osm:ready` → `osm:in-progress`.
3. **Read the spec** (`<!-- osm:plan -->` comment) — implement *that*; if the spec is materially wrong, comment and stop, don't freelance.
4. **Branch & implement:** `osm/issue-<N>-<slug>`, run repo tests/lint.
5. **Open PR:** body contains `Closes #N` + spec checklist; label `osm:awaiting-review`; request review from manager login (read from `.github/osmanager.yml`).
6. **Review loop:** on CHANGES_REQUESTED — address every inline comment, push, re-request review, relabel `osm:awaiting-review`. On APPROVED — done; **never merge**.
7. **Hard rules:** never merge, never touch rulesets/workflows/CODEOWNERS, never remove `osm:` labels you didn't add, never work without `osm:ready`.

## Auth & enforcement

- **Manager identity:** dedicated machine account (e.g. `<org>-manager-bot`) + fine-grained PAT (Contents/Issues/PRs/Statuses RW) as `OSM_GITHUB_TOKEN`. Must be distinct from every worker identity (otherwise required-review = self-review). GitHub App auth is the flagged v2 upgrade (tamper-proof check runs, higher limits) — keep `github/client.ts` auth pluggable.
- **Enforcement (`init`, once, admin token):** `CODEOWNERS`: `* @<org>-manager-bot`; ruleset on default branch: 1 approving review + require Code Owners review + dismiss stale approvals on push + required status check `os-manager/approved` + block force pushes, no bypass actors. Invariant: nothing merges without the manager's approval of the exact head SHA.
- Agent auth belongs to the local CLI (`claude auth`, Codex login/config, enterprise gateway, etc.). os-manager does not read provider API keys. `doctor` verifies the configured CLI commands are present.

Config `.github/osmanager.yml`:

```yaml
manager: { login: acme-manager-bot }
models:                                  # every role is a local CLI runner
  triage:      { provider: claude-code, model: claude-opus-4-8 }
  plan:        { provider: claude-code, model: fable }
  review:      { provider: claude-code, model: claude-opus-4-8 }  # in-depth reviewer
  meta_review: { provider: claude-code, model: fable }           # manager judge
  # optional: { provider: codex-cli, model: gpt-5-codex, args: ["--profile", "readonly_quiet"] }
poll: { interval_seconds: 60 }
policies:
  triage_prompt: |                       # appended to triage system prompt — project-fit criteria
  max_review_rounds: 3                   # worker↔manager rounds before escalation
  max_meta_rounds: 2                     # reviewer↔meta-reviewer bounces per round
  stale_after_hours: 48
budgets: { per_task_usd: 5, daily_usd: 100 }
merge: { method: squash, auto_merge_on_approve: true }
escalation: { mention: ["@junhohong"] }
labels: { prefix: osm }
```

## Guardrails

Per-task USD cap is passed to CLIs that support it (Claude Code `--max-budget-usd`); CLI sessions are also recorded against the daily budget conservatively using the configured per-task cap when exact spend is unavailable; command timeouts, max review rounds and max meta rounds → escalate, `osm:human-override` blind spot, graceful SIGINT (finish in-flight, no partial label swaps), stale-claim sweep, read-only CLI modes and secret-stripped subprocess environments as prompt-injection containment, `--dry-run` everywhere.

## Milestones (each independently demoable)

- **M1 — Skeleton & state (no LLM):** scaffold, config, Octokit client, labels/state + tests, `init`, `status`, `doctor`. Demo: init a sandbox repo; ruleset visibly blocks a direct merge.
- **M2 — Agent CLI layer + triage:** `llm/` (CLI runner map, session execution) + triage prompts/verdict + effects + markers. Demo: `os-manager triage` approves a good issue and rejects a bad one with reasoning; same command works with the runner swapped in config.
- **M3 — Plan:** workspace clones + plan action. Demo: approved issue gains a real spec + `osm:ready`.
- **M4 — Review pipeline & merge:** PR worktrees, reviewer pass, meta-review pass, review submission, status check, merge. Demo: hand-made PR → cheap model reviews in depth → Fable endorses/revises → inline comments or approve + auto-merge.
- **M5 — Daemon:** `watch` tick loop, queues, dedup, concurrency, budgets, stale sweep, escalation. Demo: unattended run; kill/restart mid-action produces no duplicate comments.
- **M6 — Worker skill & full lifecycle:** SKILL.md final, claim-race hardening, `scripts/e2e.sh`. Money demo: issue filed → triaged → planned → worker session claims via skill → PR → reviewer + meta-review request changes → fix → approved & merged → `osm:done`, no human touch.

## Verification

- **Unit (vitest):** state derivation + transition legality across label-combo fixtures; verdict parsers (well-formed/truncated/prose-wrapped JSON); CLI invocation construction; markers; config validation; tool sandboxing (path escape attempts, non-whitelisted git subcommands).
- **Integration:** `tick()` against fake Octokit fixtures asserting exact enqueued actions and marker-based dedup; `runSession()` against a mocked CLI runner; review pipeline with a scripted reviewer verdict + scripted meta-review decisions (endorse/revise/override paths).
- **E2E (`scripts/e2e.sh`):** dedicated sandbox repo, two credentials (manager PAT + worker login): seed good + bad issues, run `watch --once` repeatedly, drive a scripted worker via headless Claude Code (`claude -p "use the work-on-issue skill on <url>"`), assert final GitHub state (merged PR, `osm:done`, rejected issue closed). Run pre-release; optionally nightly with cheap models in every role.

## Top risks & mitigations

1. **GitHub can't do perfectly per-actor merge rights** → CODEOWNERS review + dismiss-stale + required status check yields the real invariant (manager approved the exact head SHA); App check-runs close the cosmetic gap in v2.
2. **CLI abstraction leaks** (Claude Code and Codex CLI flags evolve independently) → keep runner invocations small, configurable, and tested; use fenced-JSON verdicts instead of provider-specific structured-output APIs.
3. **Worker claim races** → assign → re-fetch → sole-assignee check → timestamped claim marker; worst case duplicated effort, never corruption.
4. **Duplicate actions after crash** → state-from-labels + fresh pre-action check + post-action marker comments.
5. **Cost runaway** → CLI budget flags where available, command timeouts, max review/meta-review rounds, cheap reviewer roles (review runs on Sonnet by design), dry-run.
6. **Meta-review ping-pong** (reviewer and manager disagree forever) → `max_meta_rounds` cap with `override` as the manager's bounded escape hatch, then human escalation.
