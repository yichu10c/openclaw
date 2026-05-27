import { describe, expect, it } from "vitest";
import { sanitizeCodexAgentEventValue } from "./tool-progress-normalization.js";

describe("Codex tool progress normalization", () => {
  it("omits unreadable synthetic tool progress fields", () => {
    const value: Record<string, unknown> = {
      plugin: "fuzzplugin",
      visible: "ok",
    };
    Object.defineProperty(value, "unreadable", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin progress read failed");
      },
    });

    expect(() => sanitizeCodexAgentEventValue(value)).not.toThrow();
    expect(sanitizeCodexAgentEventValue(value)).toEqual({
      plugin: "fuzzplugin",
      visible: "ok",
    });
  });
});
