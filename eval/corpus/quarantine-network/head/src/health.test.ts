import { describe, expect, it } from "vitest";
import { checkHealth } from "./health";

describe("checkHealth", () => {
  it("reports healthy for a 2xx response", async () => {
    expect(await checkHealth("http://example.com")).toBe(true);
  });
});
