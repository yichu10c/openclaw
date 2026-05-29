import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  EventStream,
  type Message,
  type Model,
} from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

function createAssistantStream(
  message: AssistantMessage,
): EventStream<AssistantMessageEvent, AssistantMessage> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => (event.type === "done" ? event.message : event.error),
  );
  stream.push({ type: "done", reason: "toolUse", message });
  return stream;
}

function createToolUseMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "mockplugin_move_angles",
        arguments: { angle: 42 },
      },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 2,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("executes healthy tools when a sibling tool name is unreadable", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "mock ok" }],
      details: { ok: true },
    }));
    const unreadableTool = {
      get name(): string {
        throw new Error("fuzzplugin tool name exploded");
      },
      label: "Fuzz",
      description: "Synthetic malformed sibling",
      parameters: Type.Object({}),
      execute: vi.fn(),
    } as unknown as AgentTool;
    const healthyTool: AgentTool = {
      name: "mockplugin_move_angles",
      label: "Move Angles",
      description: "Synthetic healthy sibling",
      parameters: Type.Object({ angle: Type.Number() }),
      execute,
    };
    const streamFn: StreamFn = async () => createAssistantStream(createToolUseMessage());

    const stream = agentLoop(
      [{ role: "user", content: "move", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [unreadableTool, healthyTool] },
      { ...config, shouldStopAfterTurn: () => true },
      undefined,
      streamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expect(execute).toHaveBeenCalledWith("call_1", { angle: 42 }, undefined, expect.any(Function));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "mockplugin_move_angles",
        isError: false,
      }),
    );
    expect(result.slice(1)).toEqual([
      expect.objectContaining({ role: "assistant", stopReason: "toolUse" }),
      expect.objectContaining({
        role: "toolResult",
        toolName: "mockplugin_move_angles",
        isError: false,
      }),
    ]);
  });
});
