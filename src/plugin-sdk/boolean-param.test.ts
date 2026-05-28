import { describe, expect, it } from "vitest";
import { readBooleanParam } from "./boolean-param.js";

describe("readBooleanParam", () => {
  it("reads boolean and string boolean params", () => {
    expect(readBooleanParam({ enabled: true }, "enabled")).toBe(true);
    expect(readBooleanParam({ enabled: "false" }, "enabled")).toBe(false);
  });

  it("treats unreadable synthetic boolean params as absent", () => {
    const params = {
      get enabled() {
        throw new Error("fuzzplugin boolean getter failed");
      },
    } as Record<string, unknown>;

    expect(readBooleanParam(params, "enabled")).toBeUndefined();
  });
});
