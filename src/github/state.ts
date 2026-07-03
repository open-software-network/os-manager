export const ISSUE_STATES = [
  "proposed",
  "approved",
  "rejected",
  "ready",
  "in-progress",
  "in-review",
  "done"
] as const;

export const PR_STATES = ["awaiting-review", "changes-requested", "approved"] as const;

export const SPECIAL_STATES = ["stale", "escalated", "human-override"] as const;

export type IssueState = (typeof ISSUE_STATES)[number] | (typeof SPECIAL_STATES)[number] | "untracked" | "conflict";
export type PrState = (typeof PR_STATES)[number] | "untracked" | "conflict" | "human-override" | "escalated";

export interface DerivedState<TState extends string> {
  state: TState;
  labels: string[];
  osmLabels: string[];
  flags: {
    humanOverride: boolean;
    escalated: boolean;
    stale: boolean;
  };
}

const issuePriority = [
  "human-override",
  "escalated",
  "stale",
  "done",
  "in-review",
  "in-progress",
  "ready",
  "rejected",
  "approved",
  "proposed"
] as const;

const prPriority = ["human-override", "escalated", "approved", "changes-requested", "awaiting-review"] as const;

function normalize(labels: Array<string | { name?: string | null }>): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter(Boolean)
    .map((label) => label.toLowerCase());
}

function osmName(prefix: string, state: string): string {
  return `${prefix}:${state}`.toLowerCase();
}

export function deriveIssueState(
  labels: Array<string | { name?: string | null }>,
  prefix = "osm"
): DerivedState<IssueState> {
  const normalized = normalize(labels);
  const osmLabels = normalized.filter((label) => label.startsWith(`${prefix.toLowerCase()}:`));
  const active = issuePriority.filter((state) => osmLabels.includes(osmName(prefix, state)));
  const normalActive = active.filter((state) => ISSUE_STATES.includes(state as (typeof ISSUE_STATES)[number]));
  const specialActive = active.filter((state) => SPECIAL_STATES.includes(state as (typeof SPECIAL_STATES)[number]));

  let state: IssueState = "untracked";
  if (specialActive.includes("human-override")) {
    state = "human-override";
  } else if (specialActive.includes("escalated")) {
    state = "escalated";
  } else if (normalActive.length > 1) {
    state = "conflict";
  } else if (specialActive.includes("stale")) {
    state = "stale";
  } else if (normalActive[0]) {
    state = normalActive[0];
  }

  return {
    state,
    labels: normalized,
    osmLabels,
    flags: {
      humanOverride: osmLabels.includes(osmName(prefix, "human-override")),
      escalated: osmLabels.includes(osmName(prefix, "escalated")),
      stale: osmLabels.includes(osmName(prefix, "stale"))
    }
  };
}

export function derivePrState(labels: Array<string | { name?: string | null }>, prefix = "osm"): DerivedState<PrState> {
  const normalized = normalize(labels);
  const osmLabels = normalized.filter((label) => label.startsWith(`${prefix.toLowerCase()}:`));
  const active = prPriority.filter((state) => osmLabels.includes(osmName(prefix, state)));
  const prActive = active.filter((state) => PR_STATES.includes(state as (typeof PR_STATES)[number]));

  let state: PrState = "untracked";
  if (active.includes("human-override")) {
    state = "human-override";
  } else if (active.includes("escalated")) {
    state = "escalated";
  } else if (prActive.length > 1) {
    state = "conflict";
  } else if (prActive[0]) {
    state = prActive[0];
  }

  return {
    state,
    labels: normalized,
    osmLabels,
    flags: {
      humanOverride: osmLabels.includes(osmName(prefix, "human-override")),
      escalated: osmLabels.includes(osmName(prefix, "escalated")),
      stale: osmLabels.includes(osmName(prefix, "stale"))
    }
  };
}

const legalIssueTransitions = new Map<IssueState, IssueState[]>([
  ["untracked", ["proposed"]],
  ["proposed", ["approved", "rejected", "escalated", "human-override"]],
  ["approved", ["ready", "escalated", "human-override"]],
  ["rejected", ["human-override"]],
  ["ready", ["in-progress", "stale", "escalated", "human-override"]],
  ["in-progress", ["ready", "in-review", "stale", "escalated", "human-override"]],
  ["in-review", ["done", "in-progress", "escalated", "human-override"]],
  ["stale", ["ready", "in-progress", "escalated", "human-override"]],
  ["escalated", ["human-override", "ready"]],
  ["human-override", ["proposed", "approved", "ready", "in-progress", "in-review", "done", "escalated"]],
  ["done", []],
  ["conflict", ["human-override", "escalated"]]
]);

const legalPrTransitions = new Map<PrState, PrState[]>([
  ["untracked", ["awaiting-review"]],
  ["awaiting-review", ["changes-requested", "approved", "escalated", "human-override"]],
  ["changes-requested", ["awaiting-review", "approved", "escalated", "human-override"]],
  ["approved", []],
  ["escalated", ["human-override", "awaiting-review"]],
  ["human-override", ["awaiting-review", "changes-requested", "approved", "escalated"]],
  ["conflict", ["human-override", "escalated"]]
]);

export function isLegalIssueTransition(from: IssueState, to: IssueState): boolean {
  return legalIssueTransitions.get(from)?.includes(to) ?? false;
}

export function isLegalPrTransition(from: PrState, to: PrState): boolean {
  return legalPrTransitions.get(from)?.includes(to) ?? false;
}
