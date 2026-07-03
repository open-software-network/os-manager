import { BudgetStore } from "../engine/budget.js";
import type { SessionUsage } from "../llm/session.js";
import { postMarkedComment, type CommandContext } from "./common.js";

export async function ensureDailyBudget(
  ctx: CommandContext,
  itemId: string,
  issueNumber: number,
  dryRun = false
): Promise<boolean> {
  const store = BudgetStore.forRepo(ctx.repo);
  const state = await store.read();
  if (state.spentUsd < ctx.config.budgets.daily_usd) {
    return true;
  }

  if (dryRun) {
    process.stdout.write(
      `[dry-run] Daily budget exhausted for ${itemId}: $${state.spentUsd.toFixed(4)} / $${ctx.config.budgets.daily_usd.toFixed(2)}\n`
    );
    return false;
  }

  const shouldComment = await store.markBudgetCommented(itemId);
  if (shouldComment) {
    await postMarkedComment(
      ctx.octokit,
      ctx.repo,
      issueNumber,
      "budget",
      { spentUsd: state.spentUsd, dailyUsd: ctx.config.budgets.daily_usd, v: 1 },
      `os-manager daily budget is exhausted. Spent $${state.spentUsd.toFixed(4)} of $${ctx.config.budgets.daily_usd.toFixed(2)}; this item will be retried after budget rollover.`
    );
  }
  return false;
}

export async function recordSessionSpend(
  ctx: CommandContext,
  usage: Pick<SessionUsage, "costUsd">,
  dryRun = false,
  fallbackUsd = ctx.config.budgets.per_task_usd
): Promise<void> {
  const amount = usage.costUsd > 0 ? usage.costUsd : fallbackUsd;
  if (dryRun || amount <= 0) {
    return;
  }
  await BudgetStore.forRepo(ctx.repo).recordSpend(amount);
}
