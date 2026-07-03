import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractFinalJson, runSession, SessionBudgetExceededError } from "../src/llm/session.js";

const modelRef = { provider: "anthropic" as const, model: "claude-sonnet-5" };
const schema = z.object({ verdict: z.literal("approve") });

describe("LLM session", () => {
  it("extracts the final fenced JSON block", () => {
    expect(extractFinalJson("Reasoning\n```json\n{\"verdict\":\"approve\"}\n```")).toEqual({ verdict: "approve" });
  });

  it("retries once when the first response is not valid verdict JSON", async () => {
    let calls = 0;
    const result = await runSession({
      role: "triage",
      modelRef,
      system: "system",
      prompt: "prompt",
      cwd: process.cwd(),
      maxSteps: 1,
      budgetUsd: 1,
      verdictSchema: schema,
      generate: async () => {
        calls += 1;
        return calls === 1
          ? { text: "missing json", usage: { inputTokens: 10, outputTokens: 10 } }
          : { text: "ok\n```json\n{\"verdict\":\"approve\"}\n```", usage: { inputTokens: 10, outputTokens: 10 } };
      }
    });
    expect(calls).toBe(2);
    expect(result.verdict.verdict).toBe("approve");
  });

  it("passes a stop condition instead of the removed maxSteps option", async () => {
    let args: Record<string, unknown> | undefined;
    await runSession({
      role: "triage",
      modelRef,
      system: "system",
      prompt: "prompt",
      cwd: process.cwd(),
      maxSteps: 3,
      budgetUsd: 1,
      verdictSchema: schema,
      generate: async (received) => {
        args = received;
        return {
          text: "ok\n```json\n{\"verdict\":\"approve\"}\n```",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    });

    expect(args).not.toHaveProperty("maxSteps");
    expect(args).toHaveProperty("stopWhen");
  });

  it("aborts when calculated cost exceeds budget", async () => {
    await expect(
      runSession({
        role: "triage",
        modelRef,
        system: "system",
        prompt: "prompt",
        cwd: process.cwd(),
        maxSteps: 1,
        budgetUsd: 0.000001,
        verdictSchema: schema,
        generate: async () => ({
          text: "ok\n```json\n{\"verdict\":\"approve\"}\n```",
          usage: { inputTokens: 10_000, outputTokens: 10_000 }
        })
      })
    ).rejects.toBeInstanceOf(SessionBudgetExceededError);
  });
});
