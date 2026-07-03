import type { Octokit } from "@octokit/rest";
import type { OsManagerConfig, RepoRef } from "../config.js";
import { getRequiredEnv, loadConfig, parseRepoRef } from "../config.js";
import { makeOctokit } from "../github/client.js";
import { hasMarker, makeMarker, parseMarkers, type MarkerKind } from "../github/markers.js";

export interface CommandContext {
  octokit: Octokit;
  repo: RepoRef;
  repoString: string;
  config: OsManagerConfig;
  token: string;
}

export async function makeCommandContext(options: { repo: string; config?: string | undefined }): Promise<CommandContext> {
  const repo = parseRepoRef(options.repo);
  const config = await loadConfig(options.config);
  const token = getRequiredEnv("OSM_GITHUB_TOKEN");
  return {
    octokit: makeOctokit(token),
    repo,
    repoString: options.repo,
    config,
    token
  };
}

export async function issueHasMarker(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  kind: MarkerKind | string
): Promise<boolean> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100
  });
  return comments.some((comment) => hasMarker(comment.body, kind));
}

export async function findMarkerComment(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  kind: MarkerKind | string
): Promise<{ id: number; body: string; payloads: unknown[] } | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100
  });
  for (const comment of comments) {
    const markers = parseMarkers(comment.body, kind);
    if (markers.length > 0) {
      return { id: comment.id, body: comment.body ?? "", payloads: markers.map((marker) => marker.payload) };
    }
  }
  return undefined;
}

export async function postMarkedComment(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  kind: MarkerKind | string,
  payload: unknown,
  markdown: string,
  dryRun = false
): Promise<void> {
  if (dryRun) {
    return;
  }
  await octokit.rest.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: makeMarker(kind, payload, markdown)
  });
}

export function formatMentions(mentions: string[]): string {
  return mentions.map((mention) => (mention.startsWith("@") ? mention : `@${mention}`)).join(" ");
}
