import { spawn } from "node:child_process";
import { z } from "zod";
import type { ModelRef } from "../config.js";
import { buildCliInvocation, runnerCommand } from "./provider.js";

export type SessionRole = "triage" | "plan" | "review" | "meta-review";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface RunSessionOptions<T> {
  role: SessionRole;
  modelRef: ModelRef;
  system: string;
  prompt: string;
  cwd: string;
  budgetUsd: number;
  verdictSchema: z.ZodType<T>;
  generate?: (args: Record<string, unknown>) => Promise<{ text?: string; usage?: unknown }>;
}

export interface SessionResult<T> {
  verdict: T;
  rawText: string;
  usage: SessionUsage;
}

export class InvalidVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVerdictError";
  }
}

function normalizeUsage(raw: unknown): Omit<SessionUsage, "costUsd"> {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const inputTokens =
    numberValue(usage.inputTokens) ??
    numberValue(usage.promptTokens) ??
    numberValue(usage.prompt_tokens) ??
    numberValue(usage.input_tokens) ??
    0;
  const outputTokens =
    numberValue(usage.outputTokens) ??
    numberValue(usage.completionTokens) ??
    numberValue(usage.completion_tokens) ??
    numberValue(usage.output_tokens) ??
    0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total_tokens) ?? inputTokens + outputTokens
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "OSM_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_PRIVATE_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY"
  ]) {
    delete env[key];
  }
  return env;
}

export function extractFinalJson(text: string): unknown {
  const match = text.trim().match(/```json\s*([\s\S]*?)\s*```\s*$/);
  if (!match?.[1]) {
    throw new InvalidVerdictError("Final assistant message must end with a fenced ```json block.");
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new InvalidVerdictError(`Final JSON block is not valid JSON: ${(error as Error).message}`);
  }
}

async function executeCli(options: RunSessionOptions<unknown>, prompt: string): Promise<{ text: string; usage: Omit<SessionUsage, "costUsd"> }> {
  const invocation = buildCliInvocation({
    ref: options.modelRef,
    system: options.system,
    prompt,
    budgetUsd: options.budgetUsd
  });

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: runnerEnv()
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${runnerCommand(options.modelRef)} timed out after ${options.modelRef.timeout_seconds}s`));
    }, invocation.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ text: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
        return;
      }
      reject(new Error(`${runnerCommand(options.modelRef)} exited with code ${code}\n${stderr || stdout}`));
    });
    child.stdin.end(invocation.input);
  });
}

async function runGenerate(
  options: RunSessionOptions<unknown>,
  prompt: string
): Promise<{ text: string; usage: Omit<SessionUsage, "costUsd"> }> {
  const generate = options.generate ?? ((args: Record<string, unknown>) => executeCli(options, String(args.prompt ?? "")));
  const result = await generate({
    runner: options.modelRef,
    system: options.system,
    prompt
  });
  return {
    text: result.text ?? "",
    usage: normalizeUsage(result.usage)
  };
}

export async function runSession<T>(options: RunSessionOptions<T>): Promise<SessionResult<T>> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastText = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? options.prompt
        : `${options.prompt}\n\nYour last response did not end with valid fenced JSON for the ${options.role} verdict. Reply again and end with only a valid \`\`\`json fenced block.`;
    const result = await runGenerate(options as RunSessionOptions<unknown>, prompt);
    lastText = result.text;
    totalInputTokens += result.usage.inputTokens;
    totalOutputTokens += result.usage.outputTokens;
    const costUsd = 0;

    try {
      const parsed = extractFinalJson(result.text);
      const verdict = options.verdictSchema.parse(parsed);
      return {
        verdict,
        rawText: result.text,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          costUsd
        }
      };
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
    }
  }

  throw new InvalidVerdictError(`No valid ${options.role} verdict produced.\n\n${lastText}`);
}

export const testOnly = { runnerEnv };
