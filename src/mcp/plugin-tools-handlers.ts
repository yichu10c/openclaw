import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { copyPluginToolMeta } from "../plugins/tool-metadata.js";
import { coerceChatContentText } from "../shared/chat-content.js";

type CallPluginToolParams = {
  name: string;
  arguments?: unknown;
};

type PluginToolsMcpEntry = {
  tool: AnyAgentTool;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

function readPluginToolField(
  tool: AnyAgentTool,
  field: "description" | "execute" | "name" | "parameters",
): { readable: true; value: unknown } | { readable: false } {
  try {
    return { readable: true, value: tool[field] };
  } catch {
    return { readable: false };
  }
}

function resolveJsonSchemaForToolParameters(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function preparePluginToolsMcpEntry(tool: AnyAgentTool): PluginToolsMcpEntry | undefined {
  const rawName = readPluginToolField(tool, "name");
  if (!rawName.readable || typeof rawName.value !== "string") {
    return undefined;
  }
  const name = rawName.value.trim();
  if (!name) {
    return undefined;
  }

  const rawExecute = readPluginToolField(tool, "execute");
  if (!rawExecute.readable || typeof rawExecute.value !== "function") {
    return undefined;
  }

  const rawParameters = readPluginToolField(tool, "parameters");
  if (!rawParameters.readable) {
    return undefined;
  }

  const rawDescription = readPluginToolField(tool, "description");
  const description =
    rawDescription.readable && typeof rawDescription.value === "string" ? rawDescription.value : "";

  try {
    const safeTool = {
      name,
      description,
      parameters: rawParameters.value,
      execute: rawExecute.value,
    } as AnyAgentTool;
    copyPluginToolMeta(tool, safeTool);
    const wrappedTool = isToolWrappedWithBeforeToolCallHook(tool)
      ? rewrapToolWithBeforeToolCallHook(tool, undefined, { approvalMode: "report" })
      : wrapToolWithBeforeToolCallHook(safeTool, undefined, { approvalMode: "report" });
    return {
      tool: wrappedTool,
      name,
      description,
      inputSchema: resolveJsonSchemaForToolParameters(rawParameters.value),
    };
  } catch {
    return undefined;
  }
}

export function createPluginToolsMcpHandlers(tools: AnyAgentTool[]) {
  const entries: PluginToolsMcpEntry[] = [];
  for (const tool of tools) {
    const entry = preparePluginToolsMcpEntry(tool);
    if (entry) {
      entries.push(entry);
    }
  }
  const toolMap = new Map<string, AnyAgentTool>();
  for (const entry of entries) {
    toolMap.set(entry.name, entry.tool);
  }

  return {
    listTools: async () => ({
      tools: entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
      })),
    }),
    callTool: async (params: CallPluginToolParams, signal?: AbortSignal) => {
      const tool = toolMap.get(params.name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }
      try {
        const result = await tool.execute(`mcp-${Date.now()}`, params.arguments ?? {}, signal);
        const rawContent =
          result && typeof result === "object" && "content" in result
            ? (result as { content?: unknown }).content
            : result;
        return {
          content: Array.isArray(rawContent)
            ? rawContent
            : [{ type: "text", text: coerceChatContentText(rawContent) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${formatErrorMessage(err)}` }],
          isError: true,
        };
      }
    },
  };
}
