import { z } from "zod";
import type { ModelRef, OsManagerConfig } from "../config.js";
import { runSession, type SessionResult } from "../llm/session.js";
import { REVIEW_SYSTEM_PROMPT } from "./prompts.js";

export const reviewCommentSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  body: z.string().min(1)
});

export const reviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summaryMarkdown: z.string(),
  comments: z.array(reviewCommentSchema).default([]),
  specChecklist: z.array(
    z.object({
      item: z.string(),
      met: z.boolean(),
      note: z.string()
    })
  )
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export interface PullRequestPromptInput {
  number: number;
  title: string;
  body?: string | null | undefined;
  baseRef: string;
  headRef: string;
  headSha: string;
  author?: string | null | undefined;
}

export function buildReviewPrompt(input: {
  pullRequest: PullRequestPromptInput;
  specMarkdown: string;
  diff: string;
  revisionGuidance?: string | undefined;
}): string {
  return `Pull request #${input.pullRequest.number}: ${input.pullRequest.title}
Author: ${input.pullRequest.author ?? "unknown"}
Base: ${input.pullRequest.baseRef}
Head: ${input.pullRequest.headRef} (${input.pullRequest.headSha})

Spec:
${input.specMarkdown}

${input.revisionGuidance ? `Meta-review revision guidance:\n${input.revisionGuidance}\n` : ""}
Diff:
${input.diff}

Return JSON:
{
  "verdict": "approve" | "request_changes",
  "summaryMarkdown": "GitHub review body",
  "comments": [{"path":"relative/path","line":123,"body":"inline comment"}],
  "specChecklist": [{"item":"acceptance criterion","met":true,"note":"evidence"}]
}`;
}

export interface RunReviewerPassOptions {
  pullRequest: PullRequestPromptInput;
  specMarkdown: string;
  diff: string;
  revisionGuidance?: string | undefined;
  cwd: string;
  modelRef: ModelRef;
  config: OsManagerConfig;
}

export async function runReviewerPassSession(options: RunReviewerPassOptions): Promise<SessionResult<ReviewVerdict>> {
  return runSession({
    role: "review",
    modelRef: options.modelRef,
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewPrompt(options),
    cwd: options.cwd,
    budgetUsd: options.config.budgets.per_task_usd,
    verdictSchema: reviewVerdictSchema
  });
}

export async function runReviewerPass(options: RunReviewerPassOptions): Promise<ReviewVerdict> {
  const result = await runReviewerPassSession(options);
  return result.verdict;
}
