import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../config.js";
import { deriveIssueState, derivePrState, type IssueState, type PrState } from "./state.js";

export const LABEL_DEFINITIONS = [
  { suffix: "proposed", color: "d4c5f9", description: "os-manager: proposed issue awaiting triage" },
  { suffix: "approved", color: "0e8a16", description: "os-manager: triaged and approved for planning" },
  { suffix: "rejected", color: "b60205", description: "os-manager: rejected by triage" },
  { suffix: "ready", color: "1d76db", description: "os-manager: planned and ready for a worker" },
  { suffix: "in-progress", color: "fbca04", description: "os-manager: claimed by a worker" },
  { suffix: "in-review", color: "5319e7", description: "os-manager: implementation PR is open" },
  { suffix: "done", color: "006b75", description: "os-manager: merged and complete" },
  { suffix: "awaiting-review", color: "c2e0c6", description: "os-manager: PR awaiting manager review" },
  { suffix: "changes-requested", color: "e99695", description: "os-manager: PR has requested changes" },
  { suffix: "stale", color: "ededed", description: "os-manager: claim is stale" },
  { suffix: "escalated", color: "d93f0b", description: "os-manager: human attention required" },
  { suffix: "human-override", color: "000000", description: "os-manager: manager must skip this item" }
] as const;

export function labelName(prefix: string, suffix: string): string {
  return `${prefix}:${suffix}`;
}

export function allLabelNames(prefix = "osm"): string[] {
  return LABEL_DEFINITIONS.map((label) => labelName(prefix, label.suffix));
}

export async function ensureLabels(octokit: Octokit, repo: RepoRef, prefix = "osm", dryRun = false): Promise<string[]> {
  const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    ...repo,
    per_page: 100
  });
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const changed: string[] = [];

  for (const definition of LABEL_DEFINITIONS) {
    const name = labelName(prefix, definition.suffix);
    const found = byName.get(name.toLowerCase());
    if (!found) {
      changed.push(`create:${name}`);
      if (!dryRun) {
        await octokit.rest.issues.createLabel({
          ...repo,
          name,
          color: definition.color,
          description: definition.description
        });
      }
      continue;
    }

    if (found.color?.toLowerCase() !== definition.color || found.description !== definition.description) {
      changed.push(`update:${name}`);
      if (!dryRun) {
        await octokit.rest.issues.updateLabel({
          ...repo,
          name,
          color: definition.color,
          description: definition.description
        });
      }
    }
  }

  return changed;
}

export async function applyIssueTransition(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  to: IssueState,
  prefix = "osm",
  dryRun = false
): Promise<void> {
  if (to === "untracked" || to === "conflict") {
    throw new Error(`Cannot transition issue to ${to}`);
  }
  const current = await octokit.rest.issues.get({ ...repo, issue_number: issueNumber });
  const currentState = deriveIssueState(current.data.labels, prefix);
  const remove = currentState.osmLabels.filter((label) => {
    const suffix = label.slice(`${prefix}:`.length);
    return suffix !== "human-override" && suffix !== "escalated" && suffix !== to;
  });
  const add = labelName(prefix, to);

  if (dryRun) {
    return;
  }
  for (const name of remove) {
    await octokit.rest.issues.removeLabel({ ...repo, issue_number: issueNumber, name }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return;
      }
      throw error;
    });
  }
  if (!currentState.labels.includes(add.toLowerCase())) {
    await octokit.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels: [add] });
  }
}

export async function applyPrTransition(
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  to: PrState,
  prefix = "osm",
  dryRun = false
): Promise<void> {
  if (to === "untracked" || to === "conflict") {
    throw new Error(`Cannot transition PR to ${to}`);
  }
  const current = await octokit.rest.issues.get({ ...repo, issue_number: prNumber });
  const currentState = derivePrState(current.data.labels, prefix);
  const remove = currentState.osmLabels.filter((label) => {
    const suffix = label.slice(`${prefix}:`.length);
    return ["awaiting-review", "changes-requested", "approved"].includes(suffix) && suffix !== to;
  });
  const add = labelName(prefix, to);

  if (dryRun) {
    return;
  }
  for (const name of remove) {
    await octokit.rest.issues.removeLabel({ ...repo, issue_number: prNumber, name }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        return;
      }
      throw error;
    });
  }
  if (!currentState.labels.includes(add.toLowerCase())) {
    await octokit.rest.issues.addLabels({ ...repo, issue_number: prNumber, labels: [add] });
  }
}
