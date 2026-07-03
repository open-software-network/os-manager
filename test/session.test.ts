import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractFinalJson, runSession, testOnly } from "../src/llm/session.js";

const modelRef = { provider: "claude-code" as const, model: "sonnet", args: [], timeout_seconds: 900 };
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

  it("passes CLI runner metadata to mocked generation", async () => {
    let args: Record<string, unknown> | undefined;
    await runSession({
      role: "triage",
      modelRef,
      system: "system",
      prompt: "prompt",
      cwd: process.cwd(),
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

    expect(args?.runner).toMatchObject({ provider: "claude-code", model: "sonnet" });
  });

  it("does not infer API spend from token counts for CLI runners", async () => {
    const result = await runSession({
      role: "triage",
      modelRef,
      system: "system",
      prompt: "prompt",
      cwd: process.cwd(),
      budgetUsd: 0.000001,
      verdictSchema: schema,
      generate: async () => ({
        text: "ok\n```json\n{\"verdict\":\"approve\"}\n```",
        usage: { inputTokens: 10_000, outputTokens: 10_000 }
      })
    });

    expect(result.usage.costUsd).toBe(0);
  });

  it("strips GitHub and provider tokens from runner subprocess env", () => {
    const previous = {
      OSM_GITHUB_TOKEN: process.env.OSM_GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };
    try {
      process.env.OSM_GITHUB_TOKEN = "secret";
      process.env.GH_TOKEN = "secret";
      process.env.GITHUB_TOKEN = "secret";
      process.env.ANTHROPIC_API_KEY = "secret";
      process.env.OPENAI_API_KEY = "secret";

      const env = testOnly.runnerEnv();

      expect(env.OSM_GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("runs through the real spawn-based CLI path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-manager-session-"));
    const script = join(dir, "fake-runner.sh");
    await writeFile(
      script,
      "#!/bin/sh\ncat >/dev/null\nprintf 'ok\\n```json\\n{\"verdict\":\"approve\"}\\n```\\n'\n",
      "utf8"
    );
    await chmod(script, 0o755);
    try {
      const result = await runSession({
        role: "triage",
        modelRef: { provider: "claude-code", command: script, args: [], timeout_seconds: 30 },
        system: "system",
        prompt: "prompt",
        cwd: process.cwd(),
        budgetUsd: 1,
        verdictSchema: schema
      });

      expect(result.verdict.verdict).toBe("approve");
      expect(result.rawText).toContain("```json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
