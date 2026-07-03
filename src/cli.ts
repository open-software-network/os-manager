#!/usr/bin/env node
import { Command } from "commander";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTriageCommand } from "./commands/triage.js";
import { registerWatchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("os-manager")
  .description("GitHub-native manager daemon for issue planning, review, and merge gating")
  .version("0.1.0");

registerInitCommand(program);
registerWatchCommand(program);
registerTriageCommand(program);
registerPlanCommand(program);
registerReviewCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
