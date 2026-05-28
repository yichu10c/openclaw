import { describe, expect, it } from "vitest";
import { describeNonJsonCompatibleValue } from "./json-compatible.js";

describe("describeNonJsonCompatibleValue", () => {
  it("describes unreadable object properties without leaking getter errors", () => {
    const schema = {
      type: "object",
      properties: {},
    };
    Object.defineProperty(schema.properties, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(() => describeNonJsonCompatibleValue(schema, "parameters")).not.toThrow();
    expect(describeNonJsonCompatibleValue(schema, "parameters")).toBe(
      "parameters.properties.fuzzplugin must be readable JSON-compatible data",
    );
  });

  it("describes unreadable array entries without leaking getter errors", () => {
    const schema = {
      enum: ["left"],
    };
    Object.defineProperty(schema.enum, "0", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(() => describeNonJsonCompatibleValue(schema, "parameters")).not.toThrow();
    expect(describeNonJsonCompatibleValue(schema, "parameters")).toBe(
      "parameters.enum[0] must be readable JSON-compatible data",
    );
  });

  it("describes objects that cannot enumerate keys", () => {
    const schema = new Proxy(
      { type: "object" },
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    expect(() => describeNonJsonCompatibleValue(schema, "parameters")).not.toThrow();
    expect(describeNonJsonCompatibleValue(schema, "parameters")).toBe(
      "parameters must be readable JSON-compatible data",
    );
  });
});
