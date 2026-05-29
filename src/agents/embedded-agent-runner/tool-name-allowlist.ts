import type { AgentTool } from "../runtime/index.js";
import type { ClientToolDefinition } from "./run/params.js";

/**
 * OpenClaw built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const AGENT_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    names.add(trimmed);
  }
}

function addReadableName(names: Set<string>, readValue: () => unknown): void {
  try {
    addName(names, readValue());
  } catch {
    // Malformed synthetic descriptors should not poison sibling allowlist entries.
  }
}

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addReadableName(names, () => tool.name);
  }
  for (const tool of params.clientTools ?? []) {
    addReadableName(names, () => tool.function?.name);
  }
  return names;
}

/**
 * Collect the exact tool names registered with the embedded agent for this session.
 */
export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    addReadableName(names, () => tool.name);
  }
  return names;
}

export function collectCoreBuiltinToolNames(
  tools: Array<{ name?: string }>,
  options?: { isPluginTool?: (tool: { name?: string }) => boolean },
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    let isPluginTool = false;
    try {
      isPluginTool = options?.isPluginTool?.(tool) ?? false;
    } catch {
      continue;
    }
    if (isPluginTool) {
      continue;
    }
    addReadableName(names, () => tool.name);
  }
  return names;
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
