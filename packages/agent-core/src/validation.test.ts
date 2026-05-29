import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "./llm.js";
import { validateToolArguments, validateToolCall } from "./validation.js";

const decimalTool = {
  name: "decimal-tool",
  description: "test tool",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      count: { type: "integer" },
    },
    required: ["amount", "count"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments", () => {
  it("coerces strict decimal numeric strings for plain JSON schemas", () => {
    expect(
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "1e3", count: "+3" },
      }),
    ).toEqual({ amount: 1000, count: 3 });
  });

  it("rejects non-decimal numeric strings for plain JSON schemas", () => {
    expect(() =>
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "0x10", count: "0b10" },
      }),
    ).toThrow(/Validation failed for tool "decimal-tool"/);
  });
});

describe("validateToolCall", () => {
  it("validates a healthy tool when a sibling tool name is unreadable", () => {
    const unreadableTool = {
      get name(): string {
        throw new Error("fuzzplugin tool name exploded");
      },
      description: "Synthetic malformed sibling",
      parameters: Type.Object({}),
    } as unknown as Tool;
    const healthyTool: Tool = {
      name: "mockplugin_move_angles",
      description: "Synthetic healthy sibling",
      parameters: Type.Object({ angle: Type.Number() }),
    };
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "call_1",
      name: "mockplugin_move_angles",
      arguments: { angle: 42 },
    };

    expect(validateToolCall([unreadableTool, healthyTool], toolCall)).toEqual({
      angle: 42,
    });
  });
});
