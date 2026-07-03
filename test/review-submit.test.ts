import { describe, expect, it } from "vitest";
import { testOnly } from "../src/commands/review.js";

function makeCtx(createReview: (args: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const octokit = {
    rest: {
      pulls: {
        createReview: async (args: Record<string, unknown>) => {
          calls.push({ name: "createReview", args });
          return createReview(args);
        }
      },
      repos: {
        createCommitStatus: async (args: Record<string, unknown>) => {
          calls.push({ name: "createCommitStatus", args });
          return {};
        }
      },
      issues: {
        createComment: async (args: Record<string, unknown>) => {
          calls.push({ name: "createComment", args });
          return {};
        },
        get: async () => ({ data: { labels: [] } }),
        addLabels: async (args: Record<string, unknown>) => {
          calls.push({ name: "addLabels", args });
          return {};
        },
        removeLabel: async (args: Record<string, unknown>) => {
          calls.push({ name: "removeLabel", args });
          return {};
        }
      }
    }
  };
  return {
    calls,
    ctx: {
      octokit,
      repo: { owner: "o", repo: "r" },
      config: {
        labels: { prefix: "osm" },
        escalation: { mention: ["@maintainer"] }
      }
    }
  };
}

describe("review submission fallbacks", () => {
  it("retries as a summary review when inline comments target unresolvable lines", async () => {
    let attempts = 0;
    const { ctx, calls } = makeCtx(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Unprocessable Entity: Line could not be resolved");
        (error as Error & { status: number }).status = 422;
        throw error;
      }
      return {};
    });

    const result = await testOnly.submitReview({
      ctx: ctx as never,
      pr: 1,
      headSha: "abc",
      reviewerModel: "reviewer",
      managerModel: "manager",
      verdict: {
        verdict: "request_changes",
        summaryMarkdown: "Needs changes.",
        comments: [{ path: "src/a.ts", line: 123, body: "Fix this." }],
        specChecklist: []
      }
    });

    expect(result).toBe("submitted");
    const reviews = calls.filter((call) => call.name === "createReview");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]?.args).not.toHaveProperty("comments");
    expect(String(reviews[1]?.args.body)).toContain("Inline comments that could not be placed automatically");
    expect(calls.some((call) => call.name === "createCommitStatus" && call.args.state === "failure")).toBe(true);
    expect(calls.some((call) => call.name === "addLabels" && Array.isArray(call.args.labels) && call.args.labels.includes("osm:changes-requested"))).toBe(true);
  });

  it("escalates when GitHub rejects manager self-review", async () => {
    const { ctx, calls } = makeCtx(async () => {
      const error = new Error("Unprocessable Entity: Review Can not request changes on your own pull request");
      (error as Error & { status: number }).status = 422;
      throw error;
    });

    const result = await testOnly.submitReview({
      ctx: ctx as never,
      pr: 1,
      headSha: "abc",
      reviewerModel: "reviewer",
      managerModel: "manager",
      verdict: {
        verdict: "request_changes",
        summaryMarkdown: "Needs changes.",
        comments: [],
        specChecklist: []
      }
    });

    expect(result).toBe("blocked");
    expect(calls.some((call) => call.name === "createComment" && String(call.args.body).includes("self-review-blocked"))).toBe(true);
    expect(calls.some((call) => call.name === "createCommitStatus" && call.args.state === "error")).toBe(true);
    expect(calls.some((call) => call.name === "addLabels" && Array.isArray(call.args.labels) && call.args.labels.includes("osm:escalated"))).toBe(true);
  });
});
