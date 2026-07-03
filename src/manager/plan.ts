import { z } from "zod";
import type { ModelRef, OsManagerConfig } from "../config.js";
import { runSession, type SessionResult } from "../llm/session.js";
import type { IssuePromptInput } from "./triage.js";
import { PLAN_SYSTEM_PROMPT } from "./prompts.js";

export const planVerdictSchema = z.object({
  specMarkdown: z.string().min(1),
  estimatedSize: z.enum(["xs", "s", "m", "l", "xl"]).or(z.string().min(1)),
  touchedAreas: z.array(z.string())
});

export type PlanVerdict = z.infer<typeof planVerdictSchema>;

export function buildPlanPrompt(issue: IssuePromptInput): string {
  return `Approved issue #${issue.number}: ${issue.title}

Issue body:
${issue.body ?? ""}

Create a worker-ready spec. The spec must be concrete enough that a bring-your-own coding agent can implement it without freelancing.

Return JSON:
{
  "specMarkdown": "public spec to post in the issue",
  "estimatedSize": "xs|s|m|l|xl",
  "touchedAreas": ["paths or subsystems likely involved"]
}`;
}

export interface RunPlanOptions {
  issue: IssuePromptInput;
  cwd: string;
  modelRef: ModelRef;
  config: OsManagerConfig;
}

export async function runPlanSession(options: RunPlanOptions): Promise<SessionResult<PlanVerdict>> {
  return runSession({
    role: "plan",
    modelRef: options.modelRef,
    system: PLAN_SYSTEM_PROMPT,
    prompt: buildPlanPrompt(options.issue),
    cwd: options.cwd,
    maxSteps: 40,
    budgetUsd: options.config.budgets.per_task_usd,
    verdictSchema: planVerdictSchema,
    config: options.config
  });
}

export async function runPlan(options: RunPlanOptions): Promise<PlanVerdict> {
  const result = await runPlanSession(options);
  return result.verdict;
}
