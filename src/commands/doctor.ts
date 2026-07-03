import type { Command } from "commander";
import { allLabelNames } from "../github/labels.js";
import { verifyProtection } from "../github/rulesets.js";
import { makeCommandContext } from "./common.js";

export async function doctor(options: { repo: string; config?: string | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  const viewer = await ctx.octokit.rest.users.getAuthenticated();
  process.stdout.write(`GitHub identity: ${viewer.data.login}\n`);
  if (viewer.data.login === ctx.config.manager.login) {
    process.stdout.write("Manager identity matches config.\n");
  } else {
    process.stdout.write(`Warning: token identity does not match manager.login (${ctx.config.manager.login}).\n`);
  }

  const labels = await ctx.octokit.paginate(ctx.octokit.rest.issues.listLabelsForRepo, { ...ctx.repo, per_page: 100 });
  const existing = new Set(labels.map((label) => label.name));
  const missing = allLabelNames(ctx.config.labels.prefix).filter((label) => !existing.has(label));
  process.stdout.write(missing.length ? `Missing labels: ${missing.join(", ")}\n` : "Labels: ok\n");

  const protection = await verifyProtection(ctx.octokit, ctx.repo);
  process.stdout.write(protection.ok ? "Protection: ok\n" : `Protection issues: ${protection.notes.join("; ")}\n`);

  for (const model of Object.values(ctx.config.models)) {
    const env = model.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    if (!process.env[env]) {
      process.stdout.write(`Missing ${env} for ${model.provider}:${model.model}\n`);
    }
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Verify token identity, labels, protection, and provider keys")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .action(async (options: { repo: string; config: string }) => {
      await doctor(options);
    });
}
