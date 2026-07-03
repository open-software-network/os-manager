# os-manager

`os-manager` is a GitHub-native manager daemon for issue triage, planning, review, and merge gating.

The v1 shape is a Node 20+ TypeScript CLI:

```sh
npm install
npm run build
OSM_GITHUB_TOKEN=... node ./dist/cli.js doctor --repo owner/repo
```

## Commands

- `init --repo owner/repo` creates `osm:*` labels, opens a PR with `.github/osmanager.yml`, installs the worker skill, writes CODEOWNERS, and creates or updates the ruleset.
- `watch --repo owner/repo [--once] [--dry-run]` polls GitHub and dispatches triage, planning, review, and stale-claim work.
- `triage <issue> --repo owner/repo` runs one issue triage pass.
- `plan <issue> --repo owner/repo` writes the manager spec and marks the issue ready.
- `review <pr> --repo owner/repo` runs reviewer -> meta-review, submits the final GitHub review, sets `os-manager/approved`, and optionally squash-merges.
- `status --repo owner/repo` prints open issues and PRs grouped by lifecycle state.
- `doctor --repo owner/repo` checks the GitHub identity, labels, protection, and configured provider keys.

## Required Environment

- `OSM_GITHUB_TOKEN`: manager machine account token with contents, issues, pull requests, statuses, and ruleset permissions.
- `ANTHROPIC_API_KEY` if any configured role uses `provider: anthropic`.
- `OPENAI_API_KEY` if any configured role uses `provider: openai`.

## Lifecycle

Issues move through `osm:proposed -> osm:approved -> osm:ready -> osm:in-progress -> osm:in-review -> osm:done`.

PRs move through `osm:awaiting-review -> osm:changes-requested -> osm:awaiting-review` until approved, then `osm:approved`.

`osm:human-override` makes the daemon skip an item. `osm:escalated` marks an item that needs a human.

## Safety

LLM sessions get only read-only repository tools. GitHub mutations are performed by deterministic TypeScript after structured verdict parsing. Review markers let the daemon recover from crashes without duplicating model work or GitHub reviews for the same head SHA.
