import type { Command } from "commander";
import { deriveIssueState, derivePrState } from "../github/state.js";
import { makeCommandContext } from "./common.js";

export async function showStatus(options: { repo: string; config?: string | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: "open",
    per_page: 100
  });
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    const labels = issue.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean);
    const state = "pull_request" in issue && issue.pull_request ? derivePrState(labels, ctx.config.labels.prefix).state : deriveIssueState(labels, ctx.config.labels.prefix).state;
    const key = `${"pull_request" in issue && issue.pull_request ? "pr" : "issue"}:${state}`;
    const line = `#${issue.number} ${issue.title}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const [group, lines] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`\n${group}\n`);
    for (const line of lines) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Print issue and PR lifecycle state grouped by os-manager labels")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .action(async (options: { repo: string; config: string }) => {
      await showStatus(options);
    });
}
