# work-on-issue

Use this skill only when asked to work on an os-manager managed GitHub issue.

## Protocol

1. Verify the issue is claimable:
   - It has the `osm:ready` label.
   - It does not have `osm:in-progress` or `osm:human-override`.
   - It has zero assignees.
   - If any check fails, stop and explain why.
2. Claim the issue:
   - Run `gh issue edit <issue> --add-assignee @me`.
   - Re-fetch the issue and verify you are the sole assignee.
   - Post a claim comment in this exact shape: `<!-- osm:claim <login> <ISO-8601 timestamp> -->`.
   - Swap `osm:ready` to `osm:in-progress`.
   - If another assignee or earlier claim marker appears, stop.
3. Read the manager spec:
   - Find the issue comment containing `<!-- osm:plan`.
   - Implement that spec. If the spec is materially wrong or impossible, comment with the blocker and stop.
4. Branch and implement:
   - Create a branch named `osm/issue-<number>-<short-slug>`.
   - Do not touch repository rulesets, workflows, or os-manager configuration unless the spec explicitly targets os-manager itself.
   - Run the repository's relevant tests and lint checks.
5. Open the PR:
   - The body must contain `Closes #<issue-number>`.
   - Include a spec checklist with each acceptance criterion.
   - Add the `osm:awaiting-review` label.
6. Review loop:
   - Watch the linked issue thread for `<!-- osm:review ... -->` manager comments.
   - If the PR is labeled `osm:changes-requested`, address the latest manager issue comment, push, and restore the `osm:awaiting-review` label.
   - If the PR is labeled `osm:approved`, stop. Never merge.

## Hard Rules

- Never merge the PR.
- Never remove os-manager labels you did not add.
- Never work without `osm:ready`.
- Never bypass branch protection or the required `os-manager/approved` status check.
