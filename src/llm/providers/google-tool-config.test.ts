import { describe, expect, it } from "vitest";
import type { Context, Model, Tool } from "../types.js";
import { streamGoogleVertex } from "./google-vertex.js";
import { streamGoogle } from "./google.js";

function makeGoogleModel(): Model<"google-generative-ai"> {
  return {
    id: "gemini-test",
    name: "Gemini Test",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function makeVertexModel(): Model<"google-vertex"> {
  return {
    id: "gemini-test",
    name: "Gemini Test",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://us-central1-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function makeOnlyInvalidProviderTools(): Tool[] {
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
  return [unreadableName, unreadableParameters, unsupportedDynamicSchema];
}

describe("Google provider tool config", () => {
  it("omits tool config when all Google provider tools are quarantined", async () => {
    let capturedPayload: unknown;
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: makeOnlyInvalidProviderTools(),
    } satisfies Context;

    const stream = streamGoogle(makeGoogleModel(), context, {
      apiKey: "sk-google-provider",
      toolChoice: "any",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop after payload");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as { config?: { tools?: unknown; toolConfig?: unknown } };
    expect(payload.config).not.toHaveProperty("tools");
    expect(payload.config).not.toHaveProperty("toolConfig");
  });

  it("omits tool config when all Vertex provider tools are quarantined", async () => {
    let capturedPayload: unknown;
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: makeOnlyInvalidProviderTools(),
    } satisfies Context;

    const stream = streamGoogleVertex(makeVertexModel(), context, {
      apiKey: "sk-google-vertex-provider",
      toolChoice: "any",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop after payload");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    const payload = capturedPayload as { config?: { tools?: unknown; toolConfig?: unknown } };
    expect(payload.config).not.toHaveProperty("tools");
    expect(payload.config).not.toHaveProperty("toolConfig");
  });
});
