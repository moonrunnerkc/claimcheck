import { describe, expect, it } from "vitest";
import { parseTimeout } from "./config";

describe("parseTimeout", () => {
  it("returns 0 for invalid config", () => {
    expect(parseTimeout("not json")).toBe(0);
  });
});
