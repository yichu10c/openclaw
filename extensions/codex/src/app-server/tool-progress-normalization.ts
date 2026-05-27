import {
  inferToolMetaFromArgs,
  type EmbeddedRunAttemptParams,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { redactSensitiveFieldValue, redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type JsonValue,
} from "./protocol.js";

function readableRecordEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, record[key]]);
    } catch {
      // Synthetic tool payloads can expose throwing getters. Treat those
      // fields as absent so progress logging still emits the readable shape.
    }
  }
  return entries;
}

export function resolveCodexToolProgressDetailMode(
  value: EmbeddedRunAttemptParams["toolProgressDetail"],
): ToolProgressDetailMode {
  return value === "raw" ? "raw" : "explain";
}

export function sanitizeCodexAgentEventValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return redactToolPayloadText(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((entry) => sanitizeCodexAgentEventValue(entry, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of readableRecordEntries(value as Record<string, unknown>)) {
      out[key] =
        typeof child === "string"
          ? redactSensitiveFieldValue(key, child)
          : sanitizeCodexAgentEventValue(child, seen);
    }
    return out;
  }
  return value;
}

export function sanitizeCodexAgentEventRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeCodexAgentEventValue(value) as Record<string, unknown>;
}

export function sanitizeCodexToolArguments(
  value: JsonValue | undefined,
): Record<string, unknown> | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return sanitizeCodexAgentEventRecord(value);
}

export function sanitizeCodexToolResponse(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  return sanitizeCodexAgentEventRecord(response as unknown as Record<string, unknown>);
}

export function inferCodexDynamicToolMeta(
  call: Pick<CodexDynamicToolCallParams, "tool" | "arguments">,
  detailMode: ToolProgressDetailMode,
): string | undefined {
  return inferToolMetaFromArgs(call.tool, call.arguments, { detailMode });
}
