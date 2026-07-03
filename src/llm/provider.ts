import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { ModelRef, OsManagerConfig } from "../config.js";

export interface Price {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const PRICE_TABLE: Record<string, Price> = {
  "claude-fable-5": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  "claude-sonnet-5": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "gpt-5": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  "gpt-5-mini": { inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
  "gpt-5-nano": { inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.4 },
  "gpt-5.6-sol": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  "gpt-5.1": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 }
};

export type LanguageModelLike = unknown;

export function resolveModel(ref: ModelRef): LanguageModelLike {
  switch (ref.provider) {
    case "anthropic":
      return anthropic(ref.model);
    case "openai":
      return openai(ref.model);
    default: {
      const exhaustive: never = ref.provider;
      throw new Error(`Unsupported provider: ${exhaustive}`);
    }
  }
}

export function priceForModel(ref: ModelRef, config?: Pick<OsManagerConfig, "prices">): Price {
  const override = config?.prices?.[ref.model];
  if (override) {
    return override;
  }
  return PRICE_TABLE[ref.model] ?? { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };
}

export function calculateCostUsd(usage: { inputTokens?: number; outputTokens?: number }, price: Price): number {
  return ((usage.inputTokens ?? 0) / 1_000_000) * price.inputUsdPerMTok + ((usage.outputTokens ?? 0) / 1_000_000) * price.outputUsdPerMTok;
}
