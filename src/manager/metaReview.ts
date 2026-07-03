import { z } from "zod";
import type { ModelRef, OsManagerConfig } from "../config.js";
import { runSession, type SessionResult } from "../llm/session.js";
import { reviewCommentSchema, type PullRequestPromptInput, type ReviewVerdict } from "./review.js";
import { META_REVIEW_SYSTEM_PROMPT } from "./prompts.js";

export const metaReviewVerdictSchema = z.object({
  decision: z.enum(["endorse", "revise", "override"]),
  commentary: z.string(),
  revisionGuidance: z.string().optional(),
  overrideVerdict: z.enum(["approve", "request_changes"]).optional(),
  additionalComments: z.array(reviewCommentSchema).default([])
});

export type MetaReviewVerdict = z.infer<typeof metaReviewVerdictSchema>;

export function buildMetaReviewPrompt(input: {
  pullRequest: PullRequestPromptInput;
  specMarkdown: string;
  diffStatAndHunks: string;
  reviewerVerdict: ReviewVerdict;
}): string {
  return `Pull request #${input.pullRequest.number}: ${input.pullRequest.title}
Head SHA: ${input.pullRequest.headSha}

Spec:
${input.specMarkdown}

Diff stat and hunks:
${input.diffStatAndHunks}

Reviewer verdict:
${JSON.stringify(input.reviewerVerdict, null, 2)}

Return JSON:
{
  "decision": "endorse" | "revise" | "override",
  "commentary": "manager-facing explanation for the final review summary",
  "revisionGuidance": "required when decision is revise",
  "overrideVerdict": "approve | request_changes, required when decision is override",
  "additionalComments": [{"path":"relative/path","line":123,"body":"inline comment"}]
}`;
}

export interface RunMetaReviewPassOptions {
  pullRequest: PullRequestPromptInput;
  specMarkdown: string;
  diffStatAndHunks: string;
  reviewerVerdict: ReviewVerdict;
  cwd: string;
  modelRef: ModelRef;
  config: OsManagerConfig;
}

export async function runMetaReviewPassSession(options: RunMetaReviewPassOptions): Promise<SessionResult<MetaReviewVerdict>> {
  return runSession({
    role: "meta-review",
    modelRef: options.modelRef,
    system: META_REVIEW_SYSTEM_PROMPT,
    prompt: buildMetaReviewPrompt(options),
    cwd: options.cwd,
    maxSteps: 15,
    budgetUsd: options.config.budgets.per_task_usd,
    verdictSchema: metaReviewVerdictSchema,
    config: options.config
  });
}

export async function runMetaReviewPass(options: RunMetaReviewPassOptions): Promise<MetaReviewVerdict> {
  const result = await runMetaReviewPassSession(options);
  return result.verdict;
}
