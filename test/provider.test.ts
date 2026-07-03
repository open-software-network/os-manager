import { describe, expect, it } from "vitest";
import { buildCliInvocation, resolveExecutable, runnerCommand } from "../src/llm/provider.js";

describe("CLI runner provider", () => {
  it("builds a Claude Code read-only print invocation", () => {
    const invocation = buildCliInvocation({
      ref: { provider: "claude-code", model: "claude-opus-4-8", args: [], timeout_seconds: 60 },
      system: "system",
      prompt: "prompt",
      budgetUsd: 1
    });

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toContain("--print");
    expect(invocation.args).toContain("--safe-mode");
    expect(invocation.args).toContain("--tools");
    expect(invocation.args).toContain("Read,Grep,Glob");
    expect(invocation.input).toBe("prompt");
  });

  it("builds a Codex CLI read-only non-interactive invocation", () => {
    const invocation = buildCliInvocation({
      ref: { provider: "codex-cli", model: "gpt-5-codex", args: [], timeout_seconds: 60 },
      system: "system",
      prompt: "prompt",
      budgetUsd: 1
    });

    expect(runnerCommand({ provider: "codex-cli", args: [], timeout_seconds: 60 })).toBe("codex");
    expect(invocation.args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--model",
      "gpt-5-codex"
    ]);
    expect(invocation.input).toContain("system");
    expect(invocation.input).toContain("prompt");
  });

  it("returns undefined for a missing absolute executable", async () => {
    await expect(resolveExecutable("/definitely/missing/os-manager-cli")).resolves.toBeUndefined();
  });
});
