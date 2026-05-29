import { describe, expect, it } from "vitest";
import type { Context, Model, Tool } from "../types.js";
import { streamMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-medium-3.5",
    name: "Mistral Medium 3.5",
    provider: "mistral",
    api: "mistral-conversations",
    baseUrl: "https://api.mistral.ai",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

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

describe("Mistral provider", () => {
  it("omits unreadable provider tools and stale pinned tool choices", async () => {
    let capturedPayload: unknown;
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: makeHostileProviderTools(),
    } satisfies Context;

    const stream = streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      toolChoice: { type: "function", function: { name: "fuzzplugin_dynamic_schema" } },
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop after payload");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as { tools?: unknown[]; toolChoice?: unknown };
    expect(payload).not.toHaveProperty("toolChoice");
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
