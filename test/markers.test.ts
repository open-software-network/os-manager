import { describe, expect, it } from "vitest";
import { hasMarker, latestMarker, makeMarker, parseMarkers } from "../src/github/markers.js";

describe("markers", () => {
  it("creates hidden comments with visible markdown", () => {
    const body = makeMarker("triage", { verdict: "approve", v: 1 }, "Looks good.");
    expect(body).toContain("<!-- osm:triage");
    expect(body).toContain("Looks good.");
    expect(hasMarker(body, "triage")).toBe(true);
  });

  it("parses multiple markers and JSON payloads", () => {
    const body = `${makeMarker("triage", { verdict: "approve" })}\n${makeMarker("plan", { estimatedSize: "s" })}`;
    const markers = parseMarkers(body);
    expect(markers).toHaveLength(2);
    expect(latestMarker<{ estimatedSize: string }>(body, "plan")?.payload.estimatedSize).toBe("s");
  });
});
