import type { Command } from "commander";
import { applyIssueTransition, applyPrTransition } from "../github/labels.js";
import { makeMarker, parseMarkers } from "../github/markers.js";
import { runMetaReviewPassSession, type MetaReviewVerdict } from "../manager/metaReview.js";
import { runReviewerPassSession, type ReviewComment, type ReviewVerdict } from "../manager/review.js";
import { ensurePullRequestWorktree, gitOutput } from "../workspace.js";
import { ensureDailyBudget, recordSessionSpend } from "./budget.js";
import { findMarkerComment, formatMentions, makeCommandContext } from "./common.js";

function issueNumberFromPrBody(body: string | null | undefined): number | undefined {
  const match = (body ?? "").match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function reviewEvent(verdict: "approve" | "request_changes"): "APPROVE" | "REQUEST_CHANGES" {
  return verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
}

function runnerLabel(provider: string, model: string | undefined): string {
  return model ? `${provider}:${model}` : provider;
}

type ApprovalStatusState = "error" | "failure" | "pending" | "success";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function setApprovalStatus(
  ctx: Awaited<ReturnType<typeof makeCommandContext>>,
  headSha: string,
  state: ApprovalStatusState,
  description: string
): Promise<void> {
  await ctx.octokit.rest.repos.createCommitStatus({
    ...ctx.repo,
    sha: headSha,
    state,
    context: "os-manager/approved",
    description
  });
}

function isOwnPullRequestReviewError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : String(error);
  return status === 422 && /your own pull request/i.test(message);
}

function isUnresolvableLineError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message : String(error);
  return status === 422 && /line could not be resolved/i.test(message);
}

function unplacedCommentsMarkdown(comments: ReviewComment[]): string {
  if (comments.length === 0) {
    return "";
  }
  const lines = comments.map((comment) => `- \`${comment.path}:${comment.line}\` — ${comment.body}`);
  return `\n\nInline comments that could not be placed automatically:\n\n${lines.join("\n")}`;
}

function combineComments(primary: ReviewComment[], additional: ReviewComment[] = []): ReviewComment[] {
  const seen = new Set<string>();
  const out: ReviewComment[] = [];
  for (const comment of [...primary, ...additional]) {
    const key = `${comment.path}:${comment.line}:${comment.body}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(comment);
    }
  }
  return out;
}

function countOsManagerReviewRounds(reviewBodies: Array<string | null | undefined>): number {
  return reviewBodies.filter((body) => /<!--\s*osm:review\b/.test(body ?? "")).length;
}

function latestReviewMarkerForHead(
  reviewBodies: Array<string | null | undefined>,
  headSha: string
): { verdict: "approve" | "request_changes" | "escalated"; headSha: string } | undefined {
  for (const body of [...reviewBodies].reverse()) {
    const marker = parseMarkers(body, "review").at(-1);
    const payload = marker?.payload as { verdict?: unknown; headSha?: unknown } | undefined;
    if (
      typeof payload?.headSha === "string" &&
      payload.headSha === headSha &&
      (payload.verdict === "approve" || payload.verdict === "request_changes" || payload.verdict === "escalated")
    ) {
      return { verdict: payload.verdict, headSha: payload.headSha };
    }
  }
  return undefined;
}

function finalVerdict(reviewer: ReviewVerdict, meta: MetaReviewVerdict): ReviewVerdict {
  if (meta.decision === "override") {
    return {
      ...reviewer,
      verdict: meta.overrideVerdict ?? reviewer.verdict,
      summaryMarkdown: meta.commentary,
      comments: combineComments([], meta.additionalComments)
    };
  }
  return {
    ...reviewer,
    summaryMarkdown: `${reviewer.summaryMarkdown}\n\nManager meta-review:\n\n${meta.commentary}`,
    comments: combineComments(reviewer.comments, meta.additionalComments)
  };
}

async function repairReviewEffects(options: {
  ctx: Awaited<ReturnType<typeof makeCommandContext>>;
  pr: number;
  headSha: string;
  verdict: "approve" | "request_changes" | "escalated";
  linkedIssue?: number | undefined;
  mergeTitle: string;
}): Promise<void> {
  if (options.verdict === "approve") {
    await setApprovalStatus(options.ctx, options.headSha, "success", "Approved by os-manager review pipeline");
    await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "approved", options.ctx.config.labels.prefix, false);
    if (options.ctx.config.merge.auto_merge_on_approve) {
      const pull = await options.ctx.octokit.rest.pulls.get({ ...options.ctx.repo, pull_number: options.pr });
      if (!pull.data.merged) {
        await options.ctx.octokit.rest.pulls.merge({
          ...options.ctx.repo,
          pull_number: options.pr,
          merge_method: options.ctx.config.merge.method,
          commit_title: options.mergeTitle
        });
      }
    }
    if (options.linkedIssue) {
      await applyIssueTransition(options.ctx.octokit, options.ctx.repo, options.linkedIssue, "done", options.ctx.config.labels.prefix, false);
    }
    return;
  }

  if (options.verdict === "request_changes") {
    await setApprovalStatus(options.ctx, options.headSha, "failure", "Changes requested by os-manager review pipeline");
    await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "changes-requested", options.ctx.config.labels.prefix, false);
    return;
  }

  await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "escalated", options.ctx.config.labels.prefix, false);
  if (options.linkedIssue) {
    await applyIssueTransition(options.ctx.octokit, options.ctx.repo, options.linkedIssue, "escalated", options.ctx.config.labels.prefix, false);
  }
}

async function submitReview(options: {
  ctx: Awaited<ReturnType<typeof makeCommandContext>>;
  pr: number;
  verdict: ReviewVerdict;
  headSha: string;
  reviewerModel: string;
  managerModel: string;
  dryRun?: boolean | undefined;
}): Promise<"submitted" | "blocked"> {
  if (options.dryRun) {
    return "submitted";
  }
  const body = makeMarker(
    "review",
    { verdict: options.verdict.verdict, headSha: options.headSha, v: 1 },
    `Reviewed by ${options.reviewerModel}; meta-reviewed by ${options.managerModel}.\n\n${options.verdict.summaryMarkdown}`
  );
  const reviewComments = options.verdict.comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: "RIGHT" as const,
    body: comment.body
  }));
  let reviewCreated = false;
  try {
    await options.ctx.octokit.rest.pulls.createReview({
      ...options.ctx.repo,
      pull_number: options.pr,
      event: reviewEvent(options.verdict.verdict),
      body,
      comments: reviewComments
    });
    reviewCreated = true;
  } catch (error) {
    if (isUnresolvableLineError(error) && reviewComments.length > 0) {
      try {
        await options.ctx.octokit.rest.pulls.createReview({
          ...options.ctx.repo,
          pull_number: options.pr,
          event: reviewEvent(options.verdict.verdict),
          body: `${body}${unplacedCommentsMarkdown(options.verdict.comments)}`
        });
        reviewCreated = true;
      } catch (retryError) {
        if (!isOwnPullRequestReviewError(retryError)) {
          throw retryError;
        }
        error = retryError;
      }
    }
    if (!reviewCreated && !isOwnPullRequestReviewError(error)) {
      throw error;
    }
    if (reviewCreated) {
      // Continue to deterministic status/label effects below.
    } else {
    await options.ctx.octokit.rest.issues.createComment({
      ...options.ctx.repo,
      issue_number: options.pr,
      body: makeMarker(
        "review",
        { verdict: "escalated", headSha: options.headSha, reason: "self-review-blocked", v: 1 },
        `os-manager completed the review pipeline, but GitHub rejected the review because the manager token belongs to the PR author. Use a dedicated manager machine account distinct from worker identities. ${formatMentions(options.ctx.config.escalation.mention)}\n\nIntended verdict: \`${options.verdict.verdict}\`\n\n${options.verdict.summaryMarkdown}`
      )
    });
    await setApprovalStatus(options.ctx, options.headSha, "error", "Manager token cannot review its own pull request");
    await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "escalated", options.ctx.config.labels.prefix, false);
    return "blocked";
    }
  }
  if (options.verdict.verdict === "approve") {
    await setApprovalStatus(options.ctx, options.headSha, "success", "Approved by os-manager review pipeline");
    await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "approved", options.ctx.config.labels.prefix, false);
  } else {
    await setApprovalStatus(options.ctx, options.headSha, "failure", "Changes requested by os-manager review pipeline");
    await applyPrTransition(options.ctx.octokit, options.ctx.repo, options.pr, "changes-requested", options.ctx.config.labels.prefix, false);
  }
  return "submitted";
}

export async function reviewPr(options: { repo: string; pr: number; config?: string | undefined; dryRun?: boolean | undefined }): Promise<void> {
  const ctx = await makeCommandContext({ repo: options.repo, config: options.config });
  const pull = await ctx.octokit.rest.pulls.get({ ...ctx.repo, pull_number: options.pr });
  if (options.dryRun) {
    process.stdout.write(`[dry-run] Would run review pipeline for PR #${options.pr} at ${pull.data.head.sha}\n`);
    return;
  }
  const linkedIssue = issueNumberFromPrBody(pull.data.body);
  let terminalStatusSet = false;
  try {
    await setApprovalStatus(ctx, pull.data.head.sha, "pending", "os-manager review in progress");
    const existingReviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
      ...ctx.repo,
      pull_number: options.pr,
      per_page: 100
    });
    const replay = latestReviewMarkerForHead(
      existingReviews.map((review) => review.body),
      pull.data.head.sha
    );
    if (replay) {
      await repairReviewEffects({
        ctx,
        pr: options.pr,
        headSha: pull.data.head.sha,
        verdict: replay.verdict,
        linkedIssue,
        mergeTitle: pull.data.title
      });
      terminalStatusSet = true;
      return;
    }
    await applyPrTransition(ctx.octokit, ctx.repo, options.pr, "awaiting-review", ctx.config.labels.prefix, false);
    if (!(await ensureDailyBudget(ctx, `pr:${options.pr}:review`, options.pr))) {
      await setApprovalStatus(ctx, pull.data.head.sha, "pending", "Daily os-manager budget exhausted; retrying later");
      return;
    }
    if (linkedIssue) {
      await applyIssueTransition(ctx.octokit, ctx.repo, linkedIssue, "in-review", ctx.config.labels.prefix, false);
    }
    if (countOsManagerReviewRounds(existingReviews.map((review) => review.body)) >= ctx.config.policies.max_review_rounds) {
      await ctx.octokit.rest.issues.createComment({
        ...ctx.repo,
        issue_number: options.pr,
        body: makeMarker(
          "review",
          { verdict: "escalated", headSha: pull.data.head.sha, v: 1 },
          `os-manager review round limit reached. ${formatMentions(ctx.config.escalation.mention)}`
        )
      });
      await setApprovalStatus(ctx, pull.data.head.sha, "error", "os-manager review round limit reached");
      terminalStatusSet = true;
      await applyPrTransition(ctx.octokit, ctx.repo, options.pr, "escalated", ctx.config.labels.prefix, false);
      if (linkedIssue) {
        await applyIssueTransition(ctx.octokit, ctx.repo, linkedIssue, "escalated", ctx.config.labels.prefix, false);
      }
      return;
    }
    const planComment = linkedIssue ? await findMarkerComment(ctx.octokit, ctx.repo, linkedIssue, "plan") : undefined;
    const specMarkdown = planComment?.body.replace(/<!--\s*osm:plan[\s\S]*?-->\s*/, "") ?? pull.data.body ?? "";
    const worktree = await ensurePullRequestWorktree(ctx.repo, options.pr, pull.data.head.sha, { token: ctx.token });
    const diff = await gitOutput(worktree, ["diff", `${pull.data.base.sha}...${pull.data.head.sha}`]).catch(async () =>
      gitOutput(worktree, ["diff", "HEAD~1...HEAD"])
    );
    const diffStat = await gitOutput(worktree, ["diff", "--stat", `${pull.data.base.sha}...${pull.data.head.sha}`]).catch(() => Promise.resolve(""));

    let reviewerVerdict: ReviewVerdict | undefined;
    let metaVerdict: MetaReviewVerdict | undefined;
    let revisionGuidance: string | undefined;
    for (let round = 0; round < ctx.config.policies.max_meta_rounds; round += 1) {
      const reviewerSession = await runReviewerPassSession({
        pullRequest: {
          number: pull.data.number,
          title: pull.data.title,
          body: pull.data.body,
          baseRef: pull.data.base.ref,
          headRef: pull.data.head.ref,
          headSha: pull.data.head.sha,
          author: pull.data.user?.login
        },
        specMarkdown,
        diff,
        revisionGuidance,
        cwd: worktree,
        modelRef: ctx.config.models.review,
        config: ctx.config
      });
      await recordSessionSpend(ctx, reviewerSession.usage, options.dryRun);
      reviewerVerdict = reviewerSession.verdict;

      if (!(await ensureDailyBudget(ctx, `pr:${options.pr}:meta-review`, options.pr))) {
        await setApprovalStatus(ctx, pull.data.head.sha, "pending", "Daily os-manager budget exhausted; retrying later");
        return;
      }
      const metaSession = await runMetaReviewPassSession({
        pullRequest: {
          number: pull.data.number,
          title: pull.data.title,
          body: pull.data.body,
          baseRef: pull.data.base.ref,
          headRef: pull.data.head.ref,
          headSha: pull.data.head.sha,
          author: pull.data.user?.login
        },
        specMarkdown,
        diffStatAndHunks: `${diffStat}\n\n${diff}`,
        reviewerVerdict,
        cwd: worktree,
        modelRef: ctx.config.models.meta_review,
        config: ctx.config
      });
      await recordSessionSpend(ctx, metaSession.usage, options.dryRun);
      metaVerdict = metaSession.verdict;
      if (metaVerdict.decision !== "revise") {
        break;
      }
      revisionGuidance = metaVerdict.revisionGuidance ?? metaVerdict.commentary;
    }

    if (!reviewerVerdict || !metaVerdict) {
      throw new Error("Review pipeline did not produce a verdict");
    }
    if (metaVerdict.decision === "revise") {
      await ctx.octokit.rest.issues.createComment({
        ...ctx.repo,
        issue_number: options.pr,
        body: makeMarker("meta-review", { decision: "revise", v: 1 }, `Meta-review could not converge.\n\n${metaVerdict.commentary}`)
      });
      await setApprovalStatus(ctx, pull.data.head.sha, "failure", "Meta-review requested another reviewer pass");
      terminalStatusSet = true;
      await applyPrTransition(ctx.octokit, ctx.repo, options.pr, "changes-requested", ctx.config.labels.prefix, false);
      return;
    }

    const verdict = finalVerdict(reviewerVerdict, metaVerdict);
    const submission = await submitReview({
      ctx,
      pr: options.pr,
      verdict,
      headSha: pull.data.head.sha,
      reviewerModel: runnerLabel(ctx.config.models.review.provider, ctx.config.models.review.model),
      managerModel: runnerLabel(ctx.config.models.meta_review.provider, ctx.config.models.meta_review.model),
      dryRun: options.dryRun
    });
    terminalStatusSet = true;
    if (submission === "blocked") {
      if (linkedIssue) {
        await applyIssueTransition(ctx.octokit, ctx.repo, linkedIssue, "escalated", ctx.config.labels.prefix, false);
      }
      return;
    }

    if (verdict.verdict === "approve" && ctx.config.merge.auto_merge_on_approve && !options.dryRun) {
      await ctx.octokit.rest.pulls.merge({
        ...ctx.repo,
        pull_number: options.pr,
        merge_method: ctx.config.merge.method,
        commit_title: pull.data.title
      });
      if (linkedIssue) {
        await applyIssueTransition(ctx.octokit, ctx.repo, linkedIssue, "done", ctx.config.labels.prefix, false);
      }
    }
  } catch (error) {
    if (!terminalStatusSet) {
      await ctx.octokit.rest.issues.createComment({
        ...ctx.repo,
        issue_number: options.pr,
        body: makeMarker(
          "review",
          { verdict: "escalated", headSha: pull.data.head.sha, reason: "review-error", v: 1 },
          `os-manager review failed before it could report a final verdict. ${formatMentions(ctx.config.escalation.mention)}\n\n${errorMessage(error)}`
        )
      });
      await setApprovalStatus(ctx, pull.data.head.sha, "error", "os-manager review failed");
      await applyPrTransition(ctx.octokit, ctx.repo, options.pr, "escalated", ctx.config.labels.prefix, false);
      if (linkedIssue) {
        await applyIssueTransition(ctx.octokit, ctx.repo, linkedIssue, "escalated", ctx.config.labels.prefix, false);
      }
    }
    throw error;
  }
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review <pr>")
    .description("Run the reviewer and meta-reviewer pipeline for a PR")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--config <path>", "config path", ".github/osmanager.yml")
    .option("--dry-run", "avoid GitHub mutations", false)
    .action(async (pr: string, options: { repo: string; config: string; dryRun: boolean }) => {
      await reviewPr({ repo: options.repo, pr: Number(pr), config: options.config, dryRun: options.dryRun });
    });
}

export const testOnly = {
  submitReview,
  isOwnPullRequestReviewError,
  isUnresolvableLineError,
  unplacedCommentsMarkdown,
  setApprovalStatus
};
