import { describe, expect, it } from "vitest";
import { testOnly } from "../src/commands/review.js";

function makeCtx() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const octokit = {
    rest: {
      pulls: {
        createReview: async (args: Record<string, unknown>) => {
          calls.push({ name: "createReview", args });
          return {};
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

describe("issue-centric review publishing", () => {
  it("posts request-changes review output to the linked issue, not the PR review API", async () => {
    const { ctx, calls } = makeCtx();

    await testOnly.publishIssueReview({
      ctx: ctx as never,
      pr: 10,
      issue: 2,
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

    expect(calls.some((call) => call.name === "createReview")).toBe(false);
    expect(calls.some((call) => call.name === "createComment" && call.args.issue_number === 2)).toBe(true);
    expect(String(calls.find((call) => call.name === "createComment")?.args.body)).toContain("PR #10 review: **changes requested**");
    expect(String(calls.find((call) => call.name === "createComment")?.args.body)).toContain("`src/a.ts:123`: Fix this.");
    expect(calls.some((call) => call.name === "createCommitStatus" && call.args.state === "failure")).toBe(true);
    expect(calls.some((call) => call.name === "addLabels" && Array.isArray(call.args.labels) && call.args.labels.includes("osm:changes-requested"))).toBe(true);
  });

  it("sets approval status when the issue-thread review approves", async () => {
    const { ctx, calls } = makeCtx();

    await testOnly.publishIssueReview({
      ctx: ctx as never,
      pr: 10,
      issue: 2,
      headSha: "abc",
      reviewerModel: "reviewer",
      managerModel: "manager",
      verdict: {
        verdict: "approve",
        summaryMarkdown: "Looks good.",
        comments: [],
        specChecklist: []
      }
    });

    expect(calls.some((call) => call.name === "createReview")).toBe(false);
    expect(calls.some((call) => call.name === "createCommitStatus" && call.args.state === "success")).toBe(true);
    expect(calls.some((call) => call.name === "addLabels" && Array.isArray(call.args.labels) && call.args.labels.includes("osm:approved"))).toBe(true);
  });
});
