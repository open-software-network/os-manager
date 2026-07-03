import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetStore, utcDay } from "../src/engine/budget.js";
import { recordSessionSpend } from "../src/commands/budget.js";

let dir: string;

describe("BudgetStore", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "os-manager-budget-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty and records spend", async () => {
    const store = new BudgetStore(join(dir, "budget.json"));
    expect(await store.canSpend(10, new Date("2026-07-03T00:00:00Z"))).toBe(true);
    await store.recordSpend(3, new Date("2026-07-03T00:00:00Z"));
    expect((await store.read(new Date("2026-07-03T00:00:00Z"))).spentUsd).toBe(3);
  });

  it("rolls over on a new UTC day", async () => {
    const store = new BudgetStore(join(dir, "budget.json"));
    await store.recordSpend(9, new Date("2026-07-03T23:00:00Z"));
    const state = await store.read(new Date("2026-07-04T01:00:00Z"));
    expect(state).toEqual({ date: "2026-07-04", spentUsd: 0, exhaustedCommentedItems: [] });
    expect(utcDay(new Date("2026-07-04T01:00:00Z"))).toBe("2026-07-04");
  });

  it("deduplicates budget exhausted comments", async () => {
    const store = new BudgetStore(join(dir, "budget.json"));
    expect(await store.markBudgetCommented("issue:1")).toBe(true);
    expect(await store.markBudgetCommented("issue:1")).toBe(false);
  });

  it("records fallback spend when CLI usage does not report exact cost", async () => {
    const ctx = {
      repo: { owner: "o", repo: "r" },
      config: { budgets: { per_task_usd: 7 } }
    };
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await recordSessionSpend(ctx as never, { costUsd: 0 });
      const store = BudgetStore.forRepo({ owner: "o", repo: "r" });
      expect((await store.read()).spentUsd).toBe(7);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
