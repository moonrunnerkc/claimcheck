import { describe, expect, it } from "vitest";
import { parseArgs, requireOption } from "./args.js";

describe("parseArgs", () => {
  it("separates the command, positionals, and options", () => {
    const parsed = parseArgs(["run", "--repo", "/x", "--head=abc", "--json"]);
    expect(parsed.command).toBe("run");
    expect(parsed.options).toEqual({ repo: "/x", head: "abc", json: "true" });
  });

  it("treats a trailing flag without a value as boolean true", () => {
    expect(parseArgs(["run", "--fail-on-warn"]).options["fail-on-warn"]).toBe("true");
  });

  it("collects positionals after the command", () => {
    const parsed = parseArgs(["replay", "out/x.json"]);
    expect(parsed.command).toBe("replay");
    expect(parsed.positionals).toEqual(["out/x.json"]);
  });
});

describe("requireOption", () => {
  it("throws naming the flag when missing", () => {
    expect(() => requireOption({}, "repo")).toThrow("--repo");
  });

  it("throws when the flag was given without a value", () => {
    expect(() => requireOption({ repo: "true" }, "repo")).toThrow("--repo");
  });

  it("returns the value when present", () => {
    expect(requireOption({ repo: "/x" }, "repo")).toBe("/x");
  });
});
