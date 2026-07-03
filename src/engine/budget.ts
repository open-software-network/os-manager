import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RepoRef } from "../config.js";
import { defaultStateDir } from "../config.js";

export interface DailyBudgetState {
  date: string;
  spentUsd: number;
  exhaustedCommentedItems: string[];
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export class BudgetStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static forRepo(repo: RepoRef): BudgetStore {
    return new BudgetStore(join(defaultStateDir(repo), "budget.json"));
  }

  async read(now = new Date()): Promise<DailyBudgetState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as DailyBudgetState;
      if (parsed.date !== utcDay(now)) {
        return { date: utcDay(now), spentUsd: 0, exhaustedCommentedItems: [] };
      }
      return {
        date: parsed.date,
        spentUsd: Number(parsed.spentUsd) || 0,
        exhaustedCommentedItems: Array.isArray(parsed.exhaustedCommentedItems) ? parsed.exhaustedCommentedItems : []
      };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") {
        return { date: utcDay(now), spentUsd: 0, exhaustedCommentedItems: [] };
      }
      throw error;
    }
  }

  async write(state: DailyBudgetState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async canSpend(limitUsd: number, now = new Date()): Promise<boolean> {
    const state = await this.read(now);
    return state.spentUsd < limitUsd;
  }

  async recordSpend(amountUsd: number, now = new Date()): Promise<DailyBudgetState> {
    const state = await this.read(now);
    const next = { ...state, spentUsd: state.spentUsd + amountUsd };
    await this.write(next);
    return next;
  }

  async markBudgetCommented(itemId: string, now = new Date()): Promise<boolean> {
    const state = await this.read(now);
    if (state.exhaustedCommentedItems.includes(itemId)) {
      return false;
    }
    const next = { ...state, exhaustedCommentedItems: [...state.exhaustedCommentedItems, itemId] };
    await this.write(next);
    return true;
  }
}
