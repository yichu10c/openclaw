import type { Tool as OpenAIResponsesTool } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { Model, Tool } from "../types.js";
import { convertResponsesTools } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;

function expectResponsesFunctionTool(tool: OpenAIResponsesTool | undefined): ResponsesFunctionTool {
  expect(tool).toHaveProperty("type", "function");
  return tool as ResponsesFunctionTool;
}

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

describe("convertResponsesTools", () => {
  it("enables native strict OpenAI Responses tools and normalizes schemas", () => {
    const tools = [
      {
        name: "lookup_weather",
        description: "Get forecast",
        parameters: {},
      },
    ] satisfies Tool[];

    const converted = convertResponsesTools(tools, { model: nativeOpenAIModel });

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup_weather",
        description: "Get forecast",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("downgrades incompatible native Responses schemas to strict false", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          },
        },
      ],
      { model: nativeOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("omits strict on proxy-like Responses routes but keeps schema normalization", () => {
    const converted = convertResponsesTools(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool).not.toHaveProperty("strict");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps tool order deterministic", () => {
    const zeta = {
      name: "zeta",
      description: "Z",
      parameters: {},
    } satisfies Tool;
    const alpha = {
      name: "alpha",
      description: "A",
      parameters: {},
    } satisfies Tool;

    expect(
      convertResponsesTools([zeta, alpha]).map((tool) => expectResponsesFunctionTool(tool).name),
    ).toEqual(["alpha", "zeta"]);
  });

  it("omits unreadable or unsupported provider tools without dropping valid siblings", () => {
    const unreadableName = Object.defineProperty(
      {
        description: "Bad name",
        parameters: { type: "object", properties: {} },
      },
      "name",
      {
        get() {
          throw new Error("fuzzplugin name exploded");
        },
      },
    ) as unknown as Tool;
    const unreadableParameters = Object.defineProperty(
      {
        name: "fuzzplugin_unreadable_parameters",
        description: "Bad parameters",
        parameters: undefined,
      },
      "parameters",
      {
        get() {
          throw new Error("fuzzplugin parameters exploded");
        },
      },
    ) as unknown as Tool;
    const unsupportedDynamicSchema = {
      name: "fuzzplugin_dynamic_schema",
      description: "Unsupported schema",
      parameters: { type: "object", properties: { target: { $dynamicRef: "#target" } } },
    } as unknown as Tool;
    const unreadableDescription = Object.defineProperty(
      {
        name: "mockplugin_status",
        description: undefined,
        parameters: { type: "object", properties: {} },
      },
      "description",
      {
        get() {
          throw new Error("mockplugin description exploded");
        },
      },
    ) as unknown as Tool;
    const healthy = {
      name: "mockplugin_lookup",
      description: "Lookup",
      parameters: { type: "object", properties: {} },
    } as unknown as Tool;

    const converted = convertResponsesTools(
      [
        unreadableName,
        unreadableParameters,
        unsupportedDynamicSchema,
        unreadableDescription,
        healthy,
      ],
      { strict: false },
    ).map(expectResponsesFunctionTool);

    expect(converted).toEqual([
      {
        type: "function",
        name: "mockplugin_lookup",
        description: "Lookup",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "mockplugin_status",
        strict: false,
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});
