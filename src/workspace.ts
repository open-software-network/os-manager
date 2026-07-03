import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoRef } from "./config.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceOptions {
  root?: string;
  token?: string;
}

export function workspaceRoot(root?: string): string {
  return root ?? join(process.env.HOME ?? process.cwd(), ".os-manager", "workspaces");
}

export function repoWorkspacePath(repo: RepoRef, root?: string): string {
  return join(workspaceRoot(root), repo.owner, repo.repo);
}

export function prWorktreePath(repo: RepoRef, prNumber: number, root?: string): string {
  return join(workspaceRoot(root), repo.owner, `${repo.repo}-pr-${prNumber}`);
}

export function githubCloneUrl(repo: RepoRef, token?: string): string {
  if (!token) {
    return `https://github.com/${repo.owner}/${repo.repo}.git`;
  }
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo.owner}/${repo.repo}.git`;
}

export async function ensureRepoClone(repo: RepoRef, options: WorkspaceOptions = {}): Promise<string> {
  const path = repoWorkspacePath(repo, options.root);
  await mkdir(join(path, ".."), { recursive: true });
  try {
    await execFileAsync("git", ["-C", path, "rev-parse", "--git-dir"]);
    await execFileAsync("git", ["-C", path, "fetch", "--all", "--prune"], { maxBuffer: 1024 * 1024 });
    return path;
  } catch {
    await execFileAsync("git", ["clone", githubCloneUrl(repo, options.token), path], { maxBuffer: 1024 * 1024 });
    return path;
  }
}

export async function ensurePullRequestWorktree(repo: RepoRef, prNumber: number, headSha: string, options: WorkspaceOptions = {}): Promise<string> {
  const clone = await ensureRepoClone(repo, options);
  const worktree = prWorktreePath(repo, prNumber, options.root);
  await execFileAsync("git", ["-C", clone, "fetch", "origin", `+pull/${prNumber}/head:refs/os-manager/pr-${prNumber}`], {
    maxBuffer: 1024 * 1024
  });
  try {
    await execFileAsync("git", ["-C", worktree, "rev-parse", "--git-dir"]);
    await execFileAsync("git", ["-C", worktree, "fetch", "origin"], { maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["-C", worktree, "checkout", headSha], { maxBuffer: 1024 * 1024 });
  } catch {
    await execFileAsync("git", ["-C", clone, "worktree", "add", "--force", worktree, headSha], { maxBuffer: 1024 * 1024 });
  }
  return worktree;
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
