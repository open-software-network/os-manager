import { z } from "zod";
import type { ModelRef, OsManagerConfig } from "../config.js";
import { runSession, type SessionResult } from "../llm/session.js";
import { TRIAGE_SYSTEM_PROMPT } from "./prompts.js";

export const triageVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  reasoning: z.string(),
  commentMarkdown: z.string()
});

export type TriageVerdict = z.infer<typeof triageVerdictSchema>;

export interface IssuePromptInput {
  number: number;
  title: string;
  body: string | null | undefined;
  author?: string | null | undefined;
  labels?: string[] | undefined;
}

export function buildTriagePrompt(issue: IssuePromptInput, extraPolicy = ""): string {
  return `Issue #${issue.number}: ${issue.title}
Author: ${issue.author ?? "unknown"}
Labels: ${(issue.labels ?? []).join(", ") || "(none)"}

Issue body:
${issue.body ?? ""}

Project-specific triage policy:
${extraPolicy || "(none)"}

Return JSON:
{
  "verdict": "approve" | "reject",
  "reasoning": "short private reasoning",
  "commentMarkdown": "public GitHub comment explaining the decision"
}`;
}

export interface RunTriageOptions {
  issue: IssuePromptInput;
  cwd: string;
  modelRef: ModelRef;
  config: OsManagerConfig;
}

export async function runTriageSession(options: RunTriageOptions): Promise<SessionResult<TriageVerdict>> {
  return runSession({
    role: "triage",
    modelRef: options.modelRef,
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: buildTriagePrompt(options.issue, options.config.policies.triage_prompt),
    cwd: options.cwd,
    maxSteps: 15,
    budgetUsd: options.config.budgets.per_task_usd,
    verdictSchema: triageVerdictSchema,
    config: options.config
  });
}

export async function runTriage(options: RunTriageOptions): Promise<TriageVerdict> {
  const result = await runTriageSession(options);
  return result.verdict;
}
