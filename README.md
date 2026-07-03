# os-manager

`os-manager` is a GitHub-native manager daemon for issue triage, planning, review, and merge gating.

The v1 shape is a Node 20+ TypeScript CLI:

```sh
npm install
npm run build
OSM_GITHUB_TOKEN=... node ./dist/cli.js doctor --repo owner/repo
```

## Commands

- `init --repo owner/repo` creates `osm:*` labels, opens a PR with `.github/osmanager.yml`, installs the worker skill, and creates or updates the ruleset.
- `watch --repo owner/repo [--once] [--dry-run]` polls GitHub and dispatches triage, planning, review, and stale-claim work.
- `triage <issue> --repo owner/repo` runs one issue triage pass.
- `plan <issue> --repo owner/repo` writes the manager spec and marks the issue ready.
- `review <pr> --repo owner/repo` runs reviewer -> meta-review, posts the final manager record to the linked issue, sets `os-manager/approved`, and optionally squash-merges.
- `status --repo owner/repo` prints open issues and PRs grouped by lifecycle state.
- `doctor --repo owner/repo` checks the GitHub identity, labels, protection, and configured local agent CLIs.

## Required Environment

- `OSM_GITHUB_TOKEN`: manager machine account token with contents, issues, pull requests, statuses, and ruleset permissions.
- A configured local agent CLI for each role:
  - `provider: claude-code` uses `claude --print` with read-only tools by default.
  - `provider: codex-cli` uses `codex exec --sandbox read-only --ask-for-approval never`.

No provider API keys are read by os-manager. Authentication and subscription state belong to the selected local CLI.

## Lifecycle

Issues move through `osm:proposed -> osm:approved -> osm:ready -> osm:in-progress -> osm:in-review -> osm:done`.

PRs move through `osm:awaiting-review -> osm:changes-requested -> osm:awaiting-review` until approved, then `osm:approved`. Review and meta-review commentary is written to the linked issue thread; the PR carries labels and the required `os-manager/approved` status check.

`osm:human-override` makes the daemon skip an item. `osm:escalated` marks an item that needs a human.

## Safety

Agent sessions run through local CLIs in read-only modes with GitHub/provider token environment variables stripped from the subprocess. GitHub mutations are performed by deterministic TypeScript after structured verdict parsing. Review markers on the issue thread let the daemon recover from crashes without duplicating model work for the same PR head SHA.
