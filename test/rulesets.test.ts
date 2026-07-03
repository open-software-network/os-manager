import { describe, expect, it } from "vitest";
import { createRuleset } from "../src/github/rulesets.js";

describe("rulesets", () => {
  it("creates the os-manager ruleset when missing", async () => {
    const requests: Array<{ route: string; payload: Record<string, unknown> }> = [];
    const octokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } })
        }
      },
      request: async (route: string, payload: Record<string, unknown>) => {
        requests.push({ route, payload });
        if (route === "GET /repos/{owner}/{repo}/rulesets") {
          return { data: [] };
        }
        return { data: {} };
      }
    };

    await createRuleset(octokit as never, { owner: "o", repo: "r" }, "bot");

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/rulesets",
      "POST /repos/{owner}/{repo}/rulesets"
    ]);
  });

  it("updates the os-manager ruleset when it already exists", async () => {
    const requests: Array<{ route: string; payload: Record<string, unknown> }> = [];
    const octokit = {
      rest: {
        repos: {
          get: async () => ({ data: { default_branch: "main" } })
        }
      },
      request: async (route: string, payload: Record<string, unknown>) => {
        requests.push({ route, payload });
        if (route === "GET /repos/{owner}/{repo}/rulesets") {
          return { data: [{ id: 123, name: "os-manager default branch protection" }] };
        }
        return { data: {} };
      }
    };

    await createRuleset(octokit as never, { owner: "o", repo: "r" }, "bot");

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/rulesets",
      "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}"
    ]);
    expect(requests.at(-1)?.payload.ruleset_id).toBe(123);
  });
});
