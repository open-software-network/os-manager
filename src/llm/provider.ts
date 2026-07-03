import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { ModelRef } from "../config.js";

export interface CliInvocation {
  command: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

export function runnerCommand(ref: ModelRef): string {
  if (ref.command) {
    return ref.command;
  }
  return ref.provider === "claude-code" ? "claude" : "codex";
}

export async function resolveExecutable(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) {
    try {
      await access(command);
      return command;
    } catch {
      return undefined;
    }
  }
  const path = process.env.PATH ?? "";
  for (const part of path.split(delimiter)) {
    const candidate = join(part, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

export function buildCliInvocation(options: {
  ref: ModelRef;
  system: string;
  prompt: string;
  budgetUsd: number;
}): CliInvocation {
  const command = runnerCommand(options.ref);
  const timeoutMs = options.ref.timeout_seconds * 1000;
  if (options.ref.provider === "claude-code") {
    const tools = options.ref.tools ?? ["Read", "Grep", "Glob"];
    const args = [
      "--print",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--safe-mode",
      "--permission-mode",
      "dontAsk",
      "--system-prompt",
      options.system,
      "--tools",
      tools.join(","),
      "--max-budget-usd",
      String(options.budgetUsd),
      ...(options.ref.model ? ["--model", options.ref.model] : []),
      ...options.ref.args
    ];
    return { command, args, input: options.prompt, timeoutMs };
  }

  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    ...(options.ref.model ? ["--model", options.ref.model] : []),
    ...options.ref.args
  ];
  return { command, args, input: `${options.system}\n\n${options.prompt}`, timeoutMs };
}
