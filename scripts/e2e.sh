#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OSM_E2E_REPO:-}" ]]; then
  echo "Set OSM_E2E_REPO=owner/repo for a sandbox repository." >&2
  exit 2
fi

if [[ -z "${OSM_GITHUB_TOKEN:-}" ]]; then
  echo "Set OSM_GITHUB_TOKEN for the manager machine account." >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Install the GitHub CLI for e2e issue seeding." >&2
  exit 2
fi

npm run build
node ./dist/cli.js doctor --repo "$OSM_E2E_REPO"

if [[ "${OSM_E2E_SEED:-0}" == "1" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  gh issue create \
    --repo "$OSM_E2E_REPO" \
    --title "os-manager e2e good issue $stamp" \
    --body "Add or update a tiny documented behavior suitable for os-manager triage and planning." >/dev/null
  gh issue create \
    --repo "$OSM_E2E_REPO" \
    --title "os-manager e2e bad issue $stamp" \
    --body "Do something vague and impossible to verify." >/dev/null
fi

if [[ "${OSM_E2E_LIVE:-0}" == "1" ]]; then
  node ./dist/cli.js watch --repo "$OSM_E2E_REPO" --once
else
  node ./dist/cli.js watch --repo "$OSM_E2E_REPO" --once --dry-run
fi

echo "E2E smoke tick completed for $OSM_E2E_REPO."
