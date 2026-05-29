import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Tool } from "../types.js";

const anthropicMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
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

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
  });

  it("keeps Cloudflare AI Gateway upstream provider auth on the Anthropic API key", async () => {
    const model = makeAnthropicModel({
      provider: "cloudflare-ai-gateway",
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
      headers: {
        "cf-aig-authorization": "Bearer gateway-token",
      },
    });
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    } satisfies Context;

    streamAnthropic(model, context, {
      apiKey: "sk-ant-provider",
    });

    await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
    const config = anthropicMockState.configs[0] as {
      apiKey?: string | null;
      authToken?: string | null;
      defaultHeaders?: Record<string, string | null>;
    };

    expect(config.apiKey).toBe("sk-ant-provider");
    expect(config.authToken).toBeNull();
    expect(config.defaultHeaders?.["x-api-key"]).toBeUndefined();
    expect(config.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer gateway-token");
  });

  it("preserves provider-signed Anthropic thinking text on replay", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    let capturedPayload: unknown;
    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseResponse([
                {
                  type: "message_start",
                  message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                { type: "message_stop" },
              ]),
            ),
        })),
      },
    };

    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [
          { role: "user", content: "hello", timestamp: 0 },
          {
            role: "assistant",
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            content: [
              {
                type: "thinking",
                thinking: signedThinking,
                thinkingSignature: "sig_1",
              },
              {
                type: "thinking",
                thinking: `sanitize${highSurrogate}synthetic`,
                thinkingSignature: "reasoning_content",
              },
            ],
          },
          { role: "user", content: "again", timestamp: 0 },
        ],
      },
      {
        apiKey: "sk-ant-provider",
        client: client as never,
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
      {
        type: "thinking",
        thinking: "sanitizesynthetic",
        signature: "reasoning_content",
      },
    ]);
  });

  it("clamps max adaptive effort when the Claude model does not advertise it", async () => {
    let capturedPayload: unknown;
    const stream = streamSimpleAnthropic(
      makeAnthropicModel({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "sk-ant-provider",
        reasoning: "max",
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    await stream.result();

    expect((capturedPayload as { output_config?: unknown }).output_config).toEqual({
      effort: "high",
    });
  });

  it("omits unreadable provider tools and stale pinned tool choices", async () => {
    let capturedPayload: unknown;
    const stream = streamAnthropic(
      makeAnthropicModel({
        compat: {
          supportsEagerToolInputStreaming: false,
          supportsCacheControlOnTools: false,
        },
      }),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: makeHostileProviderTools(),
      },
      {
        apiKey: "sk-ant-provider",
        toolChoice: { type: "tool", name: "fuzzplugin_dynamic_schema" },
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
        name: "mockplugin_status",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "mockplugin_lookup",
        description: "Lookup",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ]);
  });
});
