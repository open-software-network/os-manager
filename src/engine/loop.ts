import type { Octokit } from "@octokit/rest";
import type { OsManagerConfig, RepoRef } from "../config.js";
import { parseMarkers } from "../github/markers.js";
import { deriveIssueState, derivePrState } from "../github/state.js";

export type WorkKind = "triage" | "plan" | "review" | "stale";

export interface WorkDescriptor {
  id: string;
  kind: WorkKind;
  number: number;
  reason: string;
}

export interface TickHandlers {
  triage?: (number: number) => Promise<void>;
  plan?: (number: number) => Promise<void>;
  review?: (number: number) => Promise<void>;
  stale?: (number: number) => Promise<void>;
}

export interface TickOptions {
  octokit: Octokit;
  repo: RepoRef;
  config: OsManagerConfig;
  handlers?: TickHandlers;
  dryRun?: boolean;
  now?: Date;
}

function labelNames(labels: Array<string | { name?: string | null }>): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean);
}

function issueNumberFromPrBody(body: string | null | undefined): number | undefined {
  const match = (body ?? "").match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function latestReviewedHeadSha(reviewBodies: Array<string | null | undefined>, prNumber: number): string | undefined {
  for (const body of [...reviewBodies].reverse()) {
    const marker = parseMarkers(body, "review").at(-1);
    const payload = marker?.payload as { headSha?: unknown; pr?: unknown } | undefined;
    if (typeof payload?.headSha === "string" && (payload.pr === undefined || payload.pr === prNumber)) {
      return payload.headSha;
    }
  }
  return undefined;
}

async function needsReviewForNewHead(octokit: Octokit, repo: RepoRef, prNumber: number): Promise<boolean> {
  const pull = await octokit.rest.pulls.get({ ...repo, pull_number: prNumber });
  const linkedIssue = issueNumberFromPrBody(pull.data.body);
  if (!linkedIssue) {
    return true;
  }
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: linkedIssue,
    per_page: 100
  });
  return latestReviewedHeadSha(comments.map((comment) => comment.body), prNumber) !== pull.data.head.sha;
}

export async function discoverWork(options: TickOptions): Promise<WorkDescriptor[]> {
  const prefix = options.config.labels.prefix;
  const now = options.now ?? new Date();
  const staleMs = options.config.policies.stale_after_hours * 60 * 60 * 1000;
  const issues = await options.octokit.paginate(options.octokit.rest.issues.listForRepo, {
    ...options.repo,
    state: "open",
    per_page: 100
  });

  const work: WorkDescriptor[] = [];
  for (const item of issues) {
    const labels = labelNames(item.labels);
    if ("pull_request" in item && item.pull_request) {
      const prState = derivePrState(labels, prefix);
      if (prState.flags.humanOverride || prState.flags.escalated) {
        continue;
      }
      if (prState.state === "untracked" || prState.state === "awaiting-review") {
        work.push({
          id: `pr:${item.number}:review`,
          kind: "review",
          number: item.number,
          reason: prState.state === "untracked" ? "new PR needs manager review" : "PR awaiting manager review"
        });
        continue;
      }
      if ((prState.state === "changes-requested" || prState.state === "approved") && (await needsReviewForNewHead(options.octokit, options.repo, item.number))) {
        work.push({
          id: `pr:${item.number}:review-new-head`,
          kind: "review",
          number: item.number,
          reason: "PR head changed since the last os-manager review"
        });
      }
      continue;
    }

    const issueState = deriveIssueState(labels, prefix);
    if (issueState.flags.humanOverride || issueState.flags.escalated) {
      continue;
    }
    if (issueState.state === "untracked" || issueState.state === "proposed") {
      work.push({ id: `issue:${item.number}:triage`, kind: "triage", number: item.number, reason: "issue needs triage" });
      continue;
    }
    if (issueState.state === "approved") {
      work.push({ id: `issue:${item.number}:plan`, kind: "plan", number: item.number, reason: "approved issue needs a spec" });
      continue;
    }
    if (issueState.state === "in-progress" && item.assignees?.length && Date.parse(item.updated_at) < now.getTime() - staleMs) {
      work.push({ id: `issue:${item.number}:stale`, kind: "stale", number: item.number, reason: "claim exceeded stale timeout" });
    }
  }

  return work;
}

export async function tick(options: TickOptions): Promise<WorkDescriptor[]> {
  const work = await discoverWork(options);
  if (options.dryRun) {
    return work;
  }
  for (const item of work) {
    const handler = options.handlers?.[item.kind];
    if (handler) {
      await handler(item.number);
    }
  }
  return work;
}
