import { describe, expect, it } from "vitest";
import {
  findOpenAIStrictToolSchemaDiagnostics,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
      expect(
        resolveOpenAIStrictToolFlagForInventory([{ name: "empty", parameters: schema }], true),
      ).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIStrictToolFlagForInventory([{ name: "write", parameters: schema }], true),
    ).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toStrictEqual({});
    expect(normalized.required).toStrictEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("treats unreadable synthetic tool schemas as strict-incompatible diagnostics", () => {
    const unreadableParametersTool = Object.defineProperty(
      {
        name: "fuzzplugin_unreadable_parameters",
        parameters: undefined as unknown,
      },
      "parameters",
      {
        get() {
          throw new Error("fuzzplugin parameters exploded");
        },
      },
    );
    const unreadableNestedSchemaTool = {
      name: "fuzzplugin_nested_schema",
      parameters: Object.defineProperty({ type: "object" }, "properties", {
        enumerable: true,
        get() {
          throw new Error("fuzzplugin schema exploded");
        },
      }),
    };
    const healthyTool = {
      name: "mockplugin_lookup",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    };
    const tools = [unreadableParametersTool, unreadableNestedSchemaTool, healthyTool];

    expect(resolveOpenAIStrictToolFlagForInventory(tools, true)).toBe(false);
    expect(findOpenAIStrictToolSchemaDiagnostics(tools)).toEqual([
      {
        toolIndex: 0,
        toolName: "fuzzplugin_unreadable_parameters",
        violations: ["fuzzplugin_unreadable_parameters.parameters"],
      },
      {
        toolIndex: 1,
        toolName: "fuzzplugin_nested_schema",
        violations: ["fuzzplugin_nested_schema.parameters"],
      },
    ]);
  });
});
