import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  "discord-voice": ["tts"],
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

export function filterToolNamesByMessageProvider(
  toolNames: readonly string[],
  messageProvider?: string,
): string[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...toolNames];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (allowedTools && allowedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    return toolNames.filter((toolName) => allowedSet.has(toolName));
  }
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (!deniedTools || deniedTools.length === 0) {
    return [...toolNames];
  }
  const deniedSet = new Set(deniedTools);
  return toolNames.filter((toolName) => !deniedSet.has(toolName));
}

export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
): TTool[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...tools];
  }
  const entries: Array<{ tool: TTool; name: string }> = [];
  for (const tool of tools) {
    try {
      if (typeof tool.name === "string") {
        entries.push({ tool, name: tool.name });
      }
    } catch {
      // Malformed tool descriptors are omitted from provider-specific tool filtering.
    }
  }
  const filteredToolNames = filterToolNamesByMessageProvider(
    entries.map((entry) => entry.name),
    normalizedProvider,
  );
  const remainingCounts = new Map<string, number>();
  for (const toolName of filteredToolNames) {
    remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
  }
  const filteredTools: TTool[] = [];
  for (const entry of entries) {
    const remaining = remainingCounts.get(entry.name) ?? 0;
    if (remaining <= 0) {
      continue;
    }
    remainingCounts.set(entry.name, remaining - 1);
    filteredTools.push(entry.tool);
  }
  return filteredTools;
}
