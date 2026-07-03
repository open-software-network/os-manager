import type { Command } from "commander";
import { applyIssueTransition } from "../github/labels.js";
import { deriveIssueState } from "../github/state.js";
import { ensureRepoClone } from "../workspace.js";
import { runTriageSession } from "../manager/triage.js";
import { ensureDailyBudget, recordSessionSpend } from "./budget.js";
import { findMarkerComment, makeCommandContext, postMarkedComment } from "./common.js";

export async function triageIssue(options: { repo: string; issue: number; config?: string | undefined; dryRun?: boolean | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  const issue = await ctx.octokit.rest.issues.get({ ...ctx.repo, issue_number: options.issue });
  const state = deriveIssueState(issue.data.labels, ctx.config.labels.prefix);
  if (state.flags.humanOverride) {
    return;
  }
  const existingTriage = await findMarkerComment(ctx.octokit, ctx.repo, options.issue, "triage");
  if (existingTriage) {
    const payload = existingTriage.payloads.at(-1) as { verdict?: unknown } | undefined;
    if (payload?.verdict === "approve") {
      await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "approved", ctx.config.labels.prefix, options.dryRun);
    } else if (payload?.verdict === "reject") {
      await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "rejected", ctx.config.labels.prefix, options.dryRun);
      if (!options.dryRun) {
        await ctx.octokit.rest.issues.update({ ...ctx.repo, issue_number: options.issue, state: "closed", state_reason: "not_planned" });
      }
    }
    return;
  }

  if (state.state === "untracked") {
    await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "proposed", ctx.config.labels.prefix, options.dryRun);
  }
  if (options.dryRun) {
    process.stdout.write(`[dry-run] Would run triage for issue #${options.issue}\n`);
    return;
  }
  if (!(await ensureDailyBudget(ctx, `issue:${options.issue}:triage`, options.issue))) {
    return;
  }
  const cwd = await ensureRepoClone(ctx.repo, { token: ctx.token });
  const session = await runTriageSession({
    issue: {
      number: issue.data.number,
      title: issue.data.title,
      body: issue.data.body,
      author: issue.data.user?.login,
      labels: issue.data.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean)
    },
    cwd,
    modelRef: ctx.config.models.triage,
    config: ctx.config
  });
  await recordSessionSpend(ctx, session.usage, options.dryRun);
  const verdict = session.verdict;

  await postMarkedComment(
    ctx.octokit,
    ctx.repo,
    options.issue,
    "triage",
    { verdict: verdict.verdict, v: 1 },
    verdict.commentMarkdown,
    options.dryRun
  );

  if (verdict.verdict === "approve") {
    await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "approved", ctx.config.labels.prefix, options.dryRun);
  } else {
    await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "rejected", ctx.config.labels.prefix, options.dryRun);
    if (!options.dryRun) {
      await ctx.octokit.rest.issues.update({ ...ctx.repo, issue_number: options.issue, state: "closed", state_reason: "not_planned" });
    }
  }
}

export function registerTriageCommand(program: Command): void {
  program
    .command("triage <issue>")
    .description("Run one triage pass for an issue")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .option("--dry-run", "avoid GitHub mutations", false)
    .action(async (issue: string, options: { repo: string; config: string; dryRun: boolean }) => {
      await triageIssue({ repo: options.repo, issue: Number(issue), config: options.config, dryRun: options.dryRun });
    });
}
