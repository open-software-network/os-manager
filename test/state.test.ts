import { describe, expect, it } from "vitest";
import { deriveIssueState, derivePrState, isLegalIssueTransition, isLegalPrTransition } from "../src/github/state.js";

describe("github state derivation", () => {
  it("treats unlabeled issues as untracked", () => {
    expect(deriveIssueState(["bug"]).state).toBe("untracked");
  });

  it("derives each normal issue state", () => {
    expect(deriveIssueState(["osm:proposed"]).state).toBe("proposed");
    expect(deriveIssueState(["osm:approved"]).state).toBe("approved");
    expect(deriveIssueState(["osm:ready"]).state).toBe("ready");
    expect(deriveIssueState(["osm:in-progress"]).state).toBe("in-progress");
    expect(deriveIssueState(["osm:in-review"]).state).toBe("in-review");
    expect(deriveIssueState(["osm:done"]).state).toBe("done");
  });

  it("detects conflicting normal issue labels", () => {
    expect(deriveIssueState(["osm:ready", "osm:in-progress"]).state).toBe("conflict");
  });

  it("lets human override dominate other labels", () => {
    const state = deriveIssueState(["osm:ready", "osm:human-override"]);
    expect(state.state).toBe("human-override");
    expect(state.flags.humanOverride).toBe(true);
  });

  it("derives PR states separately", () => {
    expect(derivePrState(["osm:awaiting-review"]).state).toBe("awaiting-review");
    expect(derivePrState(["osm:changes-requested"]).state).toBe("changes-requested");
    expect(derivePrState(["osm:approved"]).state).toBe("approved");
    expect(derivePrState(["osm:approved", "osm:awaiting-review"]).state).toBe("conflict");
  });

  it("validates legal transitions", () => {
    expect(isLegalIssueTransition("untracked", "proposed")).toBe(true);
    expect(isLegalIssueTransition("ready", "done")).toBe(false);
    expect(isLegalPrTransition("awaiting-review", "changes-requested")).toBe(true);
    expect(isLegalPrTransition("approved", "awaiting-review")).toBe(false);
  });
});
