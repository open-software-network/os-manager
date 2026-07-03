import type { Command } from "commander";
import { readAsset } from "../assets.js";
import { parseRepoRef, getRequiredEnv } from "../config.js";
import { makeOctokit } from "../github/client.js";
import { ensureLabels } from "../github/labels.js";
import { createRuleset } from "../github/rulesets.js";

interface RemoteTextFile {
  sha: string;
  content: string;
}

async function getRemoteTextFile(
  octokit: ReturnType<typeof makeOctokit>,
  repo: ReturnType<typeof parseRepoRef>,
  path: string,
  ref: string
): Promise<RemoteTextFile | undefined> {
  try {
    const result = await octokit.rest.repos.getContent({ ...repo, path, ref });
    if (!Array.isArray(result.data) && "sha" in result.data && "content" in result.data && typeof result.data.content === "string") {
      return {
        sha: result.data.sha,
        content: Buffer.from(result.data.content, "base64").toString("utf8")
      };
    }
    return undefined;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    if (status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function getFileSha(octokit: ReturnType<typeof makeOctokit>, repo: ReturnType<typeof parseRepoRef>, path: string, ref: string): Promise<string | undefined> {
  return (await getRemoteTextFile(octokit, repo, path, ref))?.sha;
}

async function putFile(options: {
  octokit: ReturnType<typeof makeOctokit>;
  repo: ReturnType<typeof parseRepoRef>;
  branch: string;
  path: string;
  content: string;
  message: string;
  dryRun?: boolean | undefined;
}): Promise<void> {
  if (options.dryRun) {
    return;
  }
  const existing = await getRemoteTextFile(options.octokit, options.repo, options.path, options.branch);
  if (existing?.content === options.content) {
    return;
  }
  await options.octokit.rest.repos.createOrUpdateFileContents({
    ...options.repo,
    branch: options.branch,
    path: options.path,
    message: options.message,
    content: Buffer.from(options.content, "utf8").toString("base64"),
    ...(existing?.sha ? { sha: existing.sha } : {})
  });
}

async function ensureBranch(octokit: ReturnType<typeof makeOctokit>, repo: ReturnType<typeof parseRepoRef>, branch: string, dryRun = false): Promise<string> {
  const repository = await octokit.rest.repos.get({ ...repo });
  const defaultBranch = repository.data.default_branch;
  if (dryRun) {
    return defaultBranch;
  }
  try {
    await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
    if (status !== 404) {
      throw error;
    }
    const base = await octokit.rest.git.getRef({ ...repo, ref: `heads/${defaultBranch}` });
    await octokit.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: base.data.object.sha });
  }
  return defaultBranch;
}

async function ensurePullRequest(octokit: ReturnType<typeof makeOctokit>, repo: ReturnType<typeof parseRepoRef>, branch: string, base: string, dryRun = false): Promise<void> {
  if (dryRun) {
    return;
  }
  const pulls = await octokit.rest.pulls.list({ ...repo, state: "open", head: `${repo.owner}:${branch}` });
  if (pulls.data.length > 0) {
    return;
  }
  await octokit.rest.pulls.create({
    ...repo,
    title: "Install os-manager",
    head: branch,
    base,
    draft: false,
    body: "Adds os-manager configuration and worker skill files."
  });
}

export async function initRepo(options: {
  repo: string;
  manager?: string | undefined;
  dryRun?: boolean | undefined;
  skipRuleset?: boolean | undefined;
  bootstrapPr?: boolean | undefined;
}): Promise<void> {
  const repo = parseRepoRef(options.repo);
  const token = getRequiredEnv("OSM_GITHUB_TOKEN");
  const octokit = makeOctokit(token);
  const managerLogin = options.manager ?? `${repo.owner}-manager-bot`;
  await ensureLabels(octokit, repo, "osm", options.dryRun);

  const exampleConfig = (await readAsset("osmanager.example.yml")).replace("acme-manager-bot", managerLogin);
  const desiredFiles = [
    {
      path: ".github/osmanager.yml",
      content: exampleConfig,
      message: "Add os-manager config"
    },
    {
      path: ".claude/skills/work-on-issue/SKILL.md",
      content: await readAsset("work-on-issue/SKILL.md"),
      message: "Add os-manager worker skill"
    }
  ];

  if (options.bootstrapPr !== false) {
    const repository = await octokit.rest.repos.get({ ...repo });
    const defaultBranch = repository.data.default_branch;
    const defaultBranchHasDesiredFiles = (
      await Promise.all(desiredFiles.map(async (file) => (await getRemoteTextFile(octokit, repo, file.path, defaultBranch))?.content === file.content))
    ).every(Boolean);

    if (!defaultBranchHasDesiredFiles) {
      const branch = "os-manager/init";
      const base = await ensureBranch(octokit, repo, branch, options.dryRun);
      for (const file of desiredFiles) {
        await putFile({
          octokit,
          repo,
          branch,
          path: file.path,
          content: file.content,
          message: file.message,
          dryRun: options.dryRun
        });
      }
      await ensurePullRequest(octokit, repo, branch, base, options.dryRun);
    }
  }
  if (!options.skipRuleset) {
    await createRuleset(octokit, repo, managerLogin, "os-manager/approved", options.dryRun);
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Bootstrap labels, configuration PR, worker skill, and ruleset for a repository")
    .requiredOption("--repo <owner/repo>", "GitHub repository")
    .option("--manager <login>", "manager machine account login")
    .option("--dry-run", "avoid GitHub mutations", false)
    .option("--skip-ruleset", "skip ruleset creation", false)
    .option("--no-bootstrap-pr", "skip creating a bootstrap PR for config/skill files")
    .action(async (options: { repo: string; manager?: string; dryRun: boolean; skipRuleset: boolean; bootstrapPr: boolean }) => {
      await initRepo(options);
    });
}
