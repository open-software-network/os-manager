import type { Command } from "commander";
import { allLabelNames } from "../github/labels.js";
import { verifyProtection } from "../github/rulesets.js";
import { resolveExecutable, runnerCommand } from "../llm/provider.js";
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

  for (const [role, model] of Object.entries(ctx.config.models)) {
    const command = runnerCommand(model);
    const executable = await resolveExecutable(command);
    if (executable) {
      process.stdout.write(`${role} runner: ${model.provider} (${command}) found at ${executable}\n`);
      process.stdout.write(`  note: doctor verifies command presence only; verify ${command} authentication with that CLI directly\n`);
    } else {
      process.stdout.write(`${role} runner missing: ${model.provider} command '${command}' was not found on PATH\n`);
    }
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Verify token identity, labels, protection, and local agent CLIs")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .action(async (options: { repo: string; config: string }) => {
      await doctor(options);
    });
}
