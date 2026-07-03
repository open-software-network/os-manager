import { describe, expect, it } from "vitest";
import { discoverWork } from "../src/engine/loop.js";
import type { OsManagerConfig } from "../src/config.js";

const config: OsManagerConfig = {
  manager: { login: "bot" },
  models: {
    triage: { provider: "claude-code", model: "claude-opus-4-8", args: [], timeout_seconds: 900 },
    plan: { provider: "claude-code", model: "fable", args: [], timeout_seconds: 900 },
    review: { provider: "claude-code", model: "claude-opus-4-8", args: [], timeout_seconds: 900 },
    meta_review: { provider: "claude-code", model: "fable", args: [], timeout_seconds: 900 }
  },
  poll: { interval_seconds: 60 },
  policies: { triage_prompt: "", max_review_rounds: 3, max_meta_rounds: 2, stale_after_hours: 48 },
  budgets: { per_task_usd: 5, daily_usd: 100 },
  merge: { method: "squash", auto_merge_on_approve: true },
  escalation: { mention: [] },
  labels: { prefix: "osm" }
};

describe("work discovery", () => {
  it("queues triage, plan, review, and stale work from labels", async () => {
    const octokit = {
      rest: {
        issues: {
          listForRepo: () => undefined
        }
      },
      paginate: async () => [
        { number: 1, title: "new", labels: [], updated_at: "2026-07-03T00:00:00Z" },
        { number: 2, title: "approved", labels: [{ name: "osm:approved" }], updated_at: "2026-07-03T00:00:00Z" },
        {
          number: 3,
          title: "pr",
          labels: [{ name: "osm:awaiting-review" }],
          pull_request: {},
          updated_at: "2026-07-03T00:00:00Z"
        },
        {
          number: 4,
          title: "stale",
          labels: [{ name: "osm:in-progress" }],
          assignees: [{ login: "worker" }],
          updated_at: "2026-06-30T00:00:00Z"
        },
        {
          number: 5,
          title: "manual",
          labels: [{ name: "osm:ready" }, { name: "osm:human-override" }],
          updated_at: "2026-07-03T00:00:00Z"
        }
      ]
    };

    const work = await discoverWork({
      octokit: octokit as never,
      repo: { owner: "o", repo: "r" },
      config,
      now: new Date("2026-07-03T12:00:00Z")
    });

    expect(work.map((item) => item.kind)).toEqual(["triage", "plan", "review", "stale"]);
  });

  it("queues review for new untracked PRs", async () => {
    const listForRepo = () => undefined;
    const octokit = {
      rest: {
        issues: { listForRepo }
      },
      paginate: async () => [
        {
          number: 12,
          title: "new pr",
          labels: [],
          pull_request: {},
          updated_at: "2026-07-03T00:00:00Z"
        }
      ]
    };

    const work = await discoverWork({
      octokit: octokit as never,
      repo: { owner: "o", repo: "r" },
      config,
      now: new Date("2026-07-03T12:00:00Z")
    });

    expect(work).toEqual([
      {
        id: "pr:12:review",
        kind: "review",
        number: 12,
        reason: "new PR needs manager review"
      }
    ]);
  });

  it("queues review when a PR head changed after the last os-manager review", async () => {
    const listForRepo = () => undefined;
    const listReviews = () => undefined;
    const octokit = {
      rest: {
        issues: { listForRepo },
        pulls: {
          get: async () => ({ data: { head: { sha: "new-sha" } } }),
          listReviews
        }
      },
      paginate: async (method: unknown) => {
        if (method === listForRepo) {
          return [
            {
              number: 10,
              title: "pr",
              labels: [{ name: "osm:changes-requested" }],
              pull_request: {},
              updated_at: "2026-07-03T00:00:00Z"
            }
          ];
        }
        if (method === listReviews) {
          return [{ body: "<!-- osm:review {\"verdict\":\"request_changes\",\"headSha\":\"old-sha\",\"v\":1} -->" }];
        }
        return [];
      }
    };

    const work = await discoverWork({
      octokit: octokit as never,
      repo: { owner: "o", repo: "r" },
      config,
      now: new Date("2026-07-03T12:00:00Z")
    });

    expect(work).toEqual([
      {
        id: "pr:10:review-new-head",
        kind: "review",
        number: 10,
        reason: "PR head changed since the last os-manager review"
      }
    ]);
  });

  it("does not queue review when the latest os-manager review matches the PR head", async () => {
    const listForRepo = () => undefined;
    const listReviews = () => undefined;
    const octokit = {
      rest: {
        issues: { listForRepo },
        pulls: {
          get: async () => ({ data: { head: { sha: "same-sha" } } }),
          listReviews
        }
      },
      paginate: async (method: unknown) => {
        if (method === listForRepo) {
          return [
            {
              number: 11,
              title: "pr",
              labels: [{ name: "osm:approved" }],
              pull_request: {},
              updated_at: "2026-07-03T00:00:00Z"
            }
          ];
        }
        if (method === listReviews) {
          return [{ body: "<!-- osm:review {\"verdict\":\"approve\",\"headSha\":\"same-sha\",\"v\":1} -->" }];
        }
        return [];
      }
    };

    const work = await discoverWork({
      octokit: octokit as never,
      repo: { owner: "o", repo: "r" },
      config,
      now: new Date("2026-07-03T12:00:00Z")
    });

    expect(work).toEqual([]);
  });
});
