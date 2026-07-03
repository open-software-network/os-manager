import { describe, expect, it } from "vitest";
import { testOnly } from "../src/llm/tools.js";

describe("read-only tools", () => {
  it("rejects path escapes", () => {
    expect(() => testOnly.assertInside("/tmp/workspace", "../secret")).toThrow(/escapes/);
  });

  it("allows paths inside the workspace", () => {
    expect(testOnly.assertInside("/tmp/workspace", "src/index.ts")).toBe("/tmp/workspace/src/index.ts");
  });
});
