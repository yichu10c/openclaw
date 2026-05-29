import { afterEach, describe, expect, it } from "vitest";
import type { Context, Model, Tool } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses } from "./openai-responses.js";

const previousOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
});

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function makeHostileProviderTools(): Tool[] {
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
  return [
    unreadableName,
    unreadableParameters,
    unsupportedDynamicSchema,
    unreadableDescription,
    healthy,
  ];
}

function createBaseModel<TApi extends "openai-completions" | "openai-responses">(
  api: TApi,
): Model<TApi> {
  return {
    id: "custom-model",
    name: "Custom Model",
    api,
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4096,
  };
}

describe("OpenAI-compatible provider credentials", () => {
  it("does not use ambient OPENAI_API_KEY for generic chat-completions providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-ambient";

    const stream = streamOpenAICompletions(createBaseModel("openai-completions"), context);
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("No API key for provider: custom-openai-compatible");
  });

  it("does not use ambient OPENAI_API_KEY for generic responses providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-ambient";

    const stream = streamOpenAIResponses(createBaseModel("openai-responses"), context);
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("No API key for provider: custom-openai-compatible");
  });

  it("omits unreadable chat-completions provider tools and stale tool_choice references", async () => {
    let capturedPayload: unknown;
    const stream = streamOpenAICompletions(
      createBaseModel("openai-completions"),
      {
        ...context,
        tools: makeHostileProviderTools(),
      },
      {
        apiKey: "sk-provider",
        toolChoice: { type: "function", function: { name: "fuzzplugin_dynamic_schema" } },
        onPayload: (payload) => {
          capturedPayload = payload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as { tools?: unknown[]; tool_choice?: unknown };
    expect(payload).not.toHaveProperty("tool_choice");
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "mockplugin_status",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      },
      {
        type: "function",
        function: {
          name: "mockplugin_lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      },
    ]);
  });
});
