import type { Command } from "commander";
import { applyIssueTransition } from "../github/labels.js";
import { makeMarker } from "../github/markers.js";
import { deriveIssueState } from "../github/state.js";
import { runPlanSession } from "../manager/plan.js";
import { ensureRepoClone } from "../workspace.js";
import { ensureDailyBudget, recordSessionSpend } from "./budget.js";
import { findMarkerComment, makeCommandContext } from "./common.js";

export async function planIssue(options: { repo: string; issue: number; config?: string | undefined; dryRun?: boolean | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  const existing = await findMarkerComment(ctx.octokit, ctx.repo, options.issue, "plan");
  if (existing) {
    await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "ready", ctx.config.labels.prefix, options.dryRun);
    return;
  }
  const issue = await ctx.octokit.rest.issues.get({ ...ctx.repo, issue_number: options.issue });
  const state = deriveIssueState(issue.data.labels, ctx.config.labels.prefix);
  if (state.flags.humanOverride || state.flags.escalated) {
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`[dry-run] Would create plan for issue #${options.issue}\n`);
    return;
  }
  if (!(await ensureDailyBudget(ctx, `issue:${options.issue}:plan`, options.issue))) {
    return;
  }
  const cwd = await ensureRepoClone(ctx.repo, { token: ctx.token });
  const session = await runPlanSession({
    issue: {
      number: issue.data.number,
      title: issue.data.title,
      body: issue.data.body,
      author: issue.data.user?.login,
      labels: issue.data.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean)
    },
    cwd,
    modelRef: ctx.config.models.plan,
    config: ctx.config
  });
  await recordSessionSpend(ctx, session.usage, options.dryRun);
  const verdict = session.verdict;
  const body = makeMarker(
    "plan",
    { estimatedSize: verdict.estimatedSize, touchedAreas: verdict.touchedAreas, v: 1 },
    verdict.specMarkdown
  );
  if (!options.dryRun) {
    await ctx.octokit.rest.issues.createComment({ ...ctx.repo, issue_number: options.issue, body });
  }
  await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "ready", ctx.config.labels.prefix, options.dryRun);
}

export function registerPlanCommand(program: Command): void {
  program
    .command("plan <issue>")
    .description("Create a worker-ready spec for an approved issue")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .option("--dry-run", "avoid GitHub mutations", false)
    .action(async (issue: string, options: { repo: string; config: string; dryRun: boolean }) => {
      await planIssue({ repo: options.repo, issue: Number(issue), config: options.config, dryRun: options.dryRun });
    });
}
