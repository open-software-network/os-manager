# os-manager

GitHub-native coordination for teams running coding agents.

`os-manager` is a Node 20+ TypeScript CLI that turns GitHub issues, pull
requests, labels, rulesets, and review requirements into a manager-controlled
software delivery loop. Local coding agents can implement work, but the manager
owns triage, planning, review, status checks, and merge gating.

The result is a practical hierarchy:

- Humans decide what the repository should accept.
- `os-manager` turns accepted issues into worker-ready specs and enforces the
  lifecycle in GitHub.
- Worker agents implement issues from those specs without receiving merge
  authority.
- A reviewer model performs detailed PR review.
- A manager model meta-reviews that review, applies the final GitHub review,
  sets `os-manager/approved`, and optionally merges.

## Why This Exists

Modern coding agents are strong enough to make real changes, but giving every
agent write authority over project coordination is risky. Prompt instructions
alone are not an enforcement boundary, and a single orchestrator session does
not scale cleanly across multiple agents and humans.

`os-manager` uses GitHub as both the coordination surface and the enforcement
layer. Labels are the state machine. CODEOWNERS and rulesets are the merge gate.
LLM sessions judge and produce structured verdicts, while deterministic
TypeScript performs every GitHub mutation.

## What It Does

- Bootstraps a repository with `osm:*` lifecycle labels, a manager config file,
  worker skill, CODEOWNERS entry, and branch protection ruleset.
- Triage issues into accepted or rejected work.
- Turn accepted issues into concrete implementation specs.
- Track issue and PR state through labels instead of a private database.
- Run a reviewer -> meta-reviewer pipeline for pull requests.
- Submit GitHub reviews, set the `os-manager/approved` status check, and merge
  approved PRs when configured to do so.
- Recover from crashes using hidden marker comments, so repeated daemon ticks do
  not duplicate completed work.

## What It Does Not Do

- It does not call model provider APIs directly.
- It does not store provider API keys.
- It does not spawn worker agents in v1.
- It does not rely on prompt instructions for merge enforcement.

Agent work runs through local CLIs such as Claude Code or Codex CLI. Their
authentication, subscriptions, routing, and model access stay with those tools.

## Quick Start

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Create a GitHub token for the manager identity and export it:

```sh
export OSM_GITHUB_TOKEN=github_pat_or_token_here
```

The token should belong to the manager machine account for day-to-day operation.
For bootstrap, it also needs enough repository administration access to create
labels, files, and rulesets.

Bootstrap a target repository:

```sh
node ./dist/cli.js init --repo owner/repo --manager owner-manager-bot
```

Check the installation:

```sh
node ./dist/cli.js doctor --repo owner/repo
```

Run one daemon tick:

```sh
node ./dist/cli.js watch --repo owner/repo --once
```

Run continuously:

```sh
node ./dist/cli.js watch --repo owner/repo
```

## Lifecycle

Issues move through:

```text
osm:proposed -> osm:approved -> osm:ready -> osm:in-progress -> osm:in-review -> osm:done
```

Pull requests move through:

```text
osm:awaiting-review -> osm:changes-requested -> osm:awaiting-review -> osm:approved
```

Additional labels provide operational control:

- `osm:human-override` tells the daemon to skip an item.
- `osm:escalated` marks work that needs a human decision.
- `osm:stale` marks a claim that timed out and was returned to the ready queue.

## Core Workflow

1. A new GitHub issue appears.
2. `os-manager watch` labels it `osm:proposed` and runs triage.
3. Approved work receives a plan comment marked with `<!-- osm:plan -->` and
   moves to `osm:ready`.
4. A worker agent claims the issue, follows the installed
   `.claude/skills/work-on-issue/SKILL.md`, implements the spec, and opens a PR
   that closes the issue.
5. `os-manager` runs a detailed reviewer pass, then a manager meta-review pass.
6. The manager submits the final GitHub review.
7. Approved PRs receive the `os-manager/approved` status check and can be merged
   automatically according to config.

## Configuration

`init` opens a bootstrap PR that adds `.github/osmanager.yml`. A minimal config
looks like this:

```yaml
manager:
  login: acme-manager-bot

models:
  triage:
    provider: claude-code
    model: claude-opus-4-8
  plan:
    provider: claude-code
    model: fable
  review:
    provider: claude-code
    model: claude-opus-4-8
  meta_review:
    provider: claude-code
    model: fable

poll:
  interval_seconds: 60

policies:
  triage_prompt: ""
  max_review_rounds: 3
  max_meta_rounds: 2
  stale_after_hours: 48

budgets:
  per_task_usd: 5
  daily_usd: 100

merge:
  method: squash
  auto_merge_on_approve: true

escalation:
  mention:
    - "@junhohong"

labels:
  prefix: osm
```

Supported providers are `claude-code` and `codex-cli`. Each role can also set a
custom command, extra args, tools, and timeout.

## CLI Reference

```sh
node ./dist/cli.js init --repo owner/repo [--manager login] [--dry-run] [--skip-ruleset] [--no-bootstrap-pr]
```

Bootstraps labels, configuration, worker skill, CODEOWNERS, and the ruleset.

```sh
node ./dist/cli.js doctor --repo owner/repo [--config path]
```

Verifies the token identity, labels, protection, and configured local agent CLI
commands.

```sh
node ./dist/cli.js status --repo owner/repo [--config path]
```

Prints open issues and PRs grouped by derived lifecycle state.

```sh
node ./dist/cli.js watch --repo owner/repo [--config path] [--interval seconds] [--once] [--dry-run]
```

Runs the polling daemon. `--once` is useful for cron, tests, and manual
operation.

```sh
node ./dist/cli.js triage <issue> --repo owner/repo [--config path] [--dry-run]
node ./dist/cli.js plan <issue> --repo owner/repo [--config path] [--dry-run]
node ./dist/cli.js review <pr> --repo owner/repo [--config path] [--dry-run]
```

Run one lifecycle action directly.

## Safety Model

`os-manager` is built around a simple boundary: LLM sessions can judge, but only
deterministic code can act.

- The manager runs local agent CLIs with constrained prompts and structured JSON
  verdicts.
- GitHub tokens and provider token environment variables are stripped from model
  subprocesses.
- Hidden marker comments make actions idempotent after crashes or restarts.
- Branch protection requires the manager-owned review and the
  `os-manager/approved` status check.
- Worker agents never need merge authority.

For production use, the manager token should belong to a dedicated machine
account that is distinct from human developers and worker identities. Otherwise
GitHub may reject review submission on PRs authored by the same identity.

## Development

Run the full local check:

```sh
npm run check
```

Individual commands:

```sh
npm run typecheck
npm test
npm run build
```

The main implementation lives in `src/`, the installed worker protocol lives in
`assets/work-on-issue/SKILL.md`, and `PLAN.md` captures the v1 architecture and
milestones.
