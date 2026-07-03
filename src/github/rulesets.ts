import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../config.js";

const RULESET_NAME = "os-manager default branch protection";

function rulesetPayload(defaultBranch: string, requiredStatusCheck: string) {
  return {
    name: RULESET_NAME,
    target: "branch" as const,
    enforcement: "active" as const,
    conditions: {
      ref_name: {
        include: [`refs/heads/${defaultBranch}`],
        exclude: []
      }
    },
    rules: [
      { type: "deletion" as const },
      { type: "non_fast_forward" as const },
      {
        type: "required_status_checks" as const,
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: requiredStatusCheck }]
        }
      }
    ],
    bypass_actors: []
  };
}

export async function createRuleset(
  octokit: Octokit,
  repo: RepoRef,
  managerLogin: string,
  requiredStatusCheck = "os-manager/approved",
  dryRun = false
): Promise<void> {
  if (!managerLogin) {
    throw new Error("managerLogin is required");
  }
  if (dryRun) {
    return;
  }
  const repository = await octokit.rest.repos.get({ ...repo });
  const defaultBranch = repository.data.default_branch;
  const existing = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { ...repo });
  const current = existing.data.find((ruleset) => ruleset.name === RULESET_NAME);
  const payload = {
    ...repo,
    ...rulesetPayload(defaultBranch, requiredStatusCheck)
  };
  if (current) {
    await octokit.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      ...payload,
      ruleset_id: current.id
    });
  } else {
    await octokit.request("POST /repos/{owner}/{repo}/rulesets", payload);
  }
}

export async function verifyProtection(octokit: Octokit, repo: RepoRef): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = [];
  const rulesets = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { ...repo });
  const hasRuleset = rulesets.data.some((ruleset) => ruleset.name === RULESET_NAME);
  if (!hasRuleset) {
    notes.push("Missing os-manager ruleset");
  }

  return { ok: notes.length === 0, notes };
}
