import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import type { ModelRef, OsManagerConfig } from "../config.js";
import { calculateCostUsd, priceForModel, resolveModel, type LanguageModelLike } from "./provider.js";
import { createReadOnlyTools } from "./tools.js";

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
  maxSteps: number;
  budgetUsd: number;
  verdictSchema: z.ZodType<T>;
  config?: Pick<OsManagerConfig, "prices">;
  model?: LanguageModelLike;
  generate?: (args: Record<string, unknown>) => Promise<{ text?: string; usage?: unknown }>;
}

export interface SessionResult<T> {
  verdict: T;
  rawText: string;
  usage: SessionUsage;
}

export class SessionBudgetExceededError extends Error {
  constructor(costUsd: number, budgetUsd: number) {
    super(`LLM session exceeded budget: $${costUsd.toFixed(4)} > $${budgetUsd.toFixed(4)}`);
    this.name = "SessionBudgetExceededError";
  }
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

async function runGenerate(
  options: RunSessionOptions<unknown>,
  prompt: string
): Promise<{ text: string; usage: Omit<SessionUsage, "costUsd"> }> {
  const generate = options.generate ?? ((args: Record<string, unknown>) => generateText(args as never) as never);
  const result = await generate({
    model: options.model ?? resolveModel(options.modelRef),
    system: options.system,
    prompt,
    tools: createReadOnlyTools(options.cwd),
    stopWhen: stepCountIs(options.maxSteps)
  });
  return {
    text: result.text ?? "",
    usage: normalizeUsage(result.usage)
  };
}

export async function runSession<T>(options: RunSessionOptions<T>): Promise<SessionResult<T>> {
  const price = priceForModel(options.modelRef, options.config);
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
    const costUsd = calculateCostUsd({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens }, price);
    if (costUsd > options.budgetUsd) {
      throw new SessionBudgetExceededError(costUsd, options.budgetUsd);
    }

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
