import { describe, expect, it } from "vitest";
import {
  filterToolNamesByMessageProvider,
  filterToolsByMessageProvider,
} from "./agent-tools.message-provider-policy.js";

const DEFAULT_TOOL_NAMES = ["read", "write", "tts", "web_search"];

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice ", "discord-voice", "DISCORD-VOICE", " Discord-Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, messageProvider));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });

  it("omits unreadable synthetic tool names while preserving healthy provider tools", () => {
    const unreadableTool: Record<string, unknown> = {};
    Object.defineProperty(unreadableTool, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin message provider tool name read failed");
      },
    });
    const readTool = { name: "read" };
    const ttsTool = { name: "tts" };

    expect(
      filterToolsByMessageProvider(
        [unreadableTool as { name: string }, readTool, ttsTool],
        "voice",
      ),
    ).toStrictEqual([readTool]);
  });
});
