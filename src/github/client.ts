import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

const ThrottledOctokit = Octokit.plugin(throttling);

export function makeOctokit(auth: string): Octokit {
  return new ThrottledOctokit({
    auth,
    throttle: {
      onRateLimit: (_retryAfter: number, options: { method: string; url: string }, octokit: { log: { warn: (message: string) => void } }, retryCount: number) => {
        octokit.log.warn(`Request quota exhausted for ${options.method} ${options.url}`);
        return retryCount < 2;
      },
      onSecondaryRateLimit: (_retryAfter: number, options: { method: string; url: string }, octokit: { log: { warn: (message: string) => void } }) => {
        octokit.log.warn(`Secondary rate limit for ${options.method} ${options.url}`);
        return false;
      }
    } as never
  }) as Octokit;
}
