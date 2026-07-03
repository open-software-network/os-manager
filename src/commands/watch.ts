import type { Command } from "commander";
import { tick } from "../engine/loop.js";
import { Scheduler } from "../engine/scheduler.js";
import { applyIssueTransition } from "../github/labels.js";
import { makeCommandContext } from "./common.js";
import { planIssue } from "./plan.js";
import { reviewPr } from "./review.js";
import { triageIssue } from "./triage.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function staleIssue(options: { repo: string; issue: number; config?: string | undefined; dryRun?: boolean | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  if (options.dryRun) {
    process.stdout.write(`[dry-run] Would mark stale claim on issue #${options.issue}\n`);
    return;
  }
  const issue = await ctx.octokit.rest.issues.get({ ...ctx.repo, issue_number: options.issue });
  for (const assignee of issue.data.assignees ?? []) {
    await ctx.octokit.rest.issues.removeAssignees({ ...ctx.repo, issue_number: options.issue, assignees: [assignee.login] });
  }
  await applyIssueTransition(ctx.octokit, ctx.repo, options.issue, "ready", ctx.config.labels.prefix, false);
  await ctx.octokit.rest.issues.addLabels({ ...ctx.repo, issue_number: options.issue, labels: [`${ctx.config.labels.prefix}:stale`] });
}

export async function watch(options: {
  repo: string;
  config?: string | undefined;
  once?: boolean | undefined;
  interval?: number | undefined;
  dryRun?: boolean | undefined;
}): Promise<void> {
  const scheduler = new Scheduler(2);
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  do {
    const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
    const work = await tick({
      octokit: ctx.octokit,
      repo: ctx.repo,
      config: ctx.config,
      dryRun: true
    });
    for (const item of work) {
      const enqueued = scheduler.enqueue({
        id: item.id,
        kind: item.kind,
        run: async () => {
          if (item.kind === "triage") {
            await triageIssue({ repo: options.repo, issue: item.number, config: options.config, dryRun: options.dryRun });
          } else if (item.kind === "plan") {
            await planIssue({ repo: options.repo, issue: item.number, config: options.config, dryRun: options.dryRun });
          } else if (item.kind === "review") {
            await reviewPr({ repo: options.repo, pr: item.number, config: options.config, dryRun: options.dryRun });
          } else {
            await staleIssue({ repo: options.repo, issue: item.number, config: options.config, dryRun: options.dryRun });
          }
        }
      });
      if (options.once && enqueued) {
        await enqueued;
      }
    }
    if (options.once) {
      return;
    }
    await sleep((options.interval ?? ctx.config.poll.interval_seconds) * 1000);
  } while (!stopping);
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Run the os-manager polling daemon")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .option("--interval <seconds>", "poll interval seconds", Number)
    .option("--once", "run a single tick", false)
    .option("--dry-run", "avoid GitHub mutations", false)
    .action(async (options: { repo: string; config: string; interval?: number; once: boolean; dryRun: boolean }) => {
      await watch(options);
    });
}
