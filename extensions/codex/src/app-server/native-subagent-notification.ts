import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const CODEX_SUBAGENT_NOTIFICATION_START = "<subagent_notification>";
const CODEX_SUBAGENT_NOTIFICATION_END = "</subagent_notification>";

export type CodexNativeSubagentCompletionStatus = "succeeded" | "failed" | "cancelled";

type CodexNativeSubagentCompletionDetails = {
  status: CodexNativeSubagentCompletionStatus;
  statusLabel: string;
  result: string;
};

export type CodexNativeSubagentCompletion = CodexNativeSubagentCompletionDetails & {
  childThreadId: string;
};

export type CodexNativeSubagentNotificationCompletion = CodexNativeSubagentCompletionDetails & {
  agentPath: string;
};

export function extractCodexNativeSubagentCompletions(
  notification: CodexServerNotification,
): CodexNativeSubagentNotificationCompletion[] {
  const params = readJsonObject(notification, "params");
  if (!params) {
    return [];
  }
  const item = readJsonObject(params, "item");
  if (!item) {
    return [];
  }
  const text = readTrustedInterAgentCommunicationContent(item);
  if (!text) {
    return [];
  }
  const author = readTrustedInterAgentCommunicationAuthor(item);
  return extractCodexNativeSubagentCompletionsFromText(text).filter(
    (completion) => completion.agentPath === author,
  );
}

export function extractCodexNativeSubagentCompletionsFromText(
  text: string,
): CodexNativeSubagentNotificationCompletion[] {
  const completions: CodexNativeSubagentNotificationCompletion[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_START, cursor);
    if (start < 0) {
      break;
    }
    const bodyStart = start + CODEX_SUBAGENT_NOTIFICATION_START.length;
    const end = text.indexOf(CODEX_SUBAGENT_NOTIFICATION_END, bodyStart);
    if (end < 0) {
      break;
    }
    const parsed = parseCodexNativeSubagentNotificationBody(text.slice(bodyStart, end));
    if (parsed) {
      completions.push(parsed);
    }
    cursor = end + CODEX_SUBAGENT_NOTIFICATION_END.length;
  }
  return completions;
}

function parseCodexNativeSubagentNotificationBody(
  body: string,
): CodexNativeSubagentNotificationCompletion | undefined {
  let payload: JsonValue;
  try {
    payload = JSON.parse(body.trim());
  } catch {
    return undefined;
  }
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const agentPath = readString(payload, "agent_path")?.trim();
  const status = readJsonObject(payload, "status");
  if (!agentPath || !status) {
    return undefined;
  }
  const statusEntry = readCompletionStatus(status);
  if (!statusEntry) {
    return undefined;
  }
  return {
    agentPath,
    status: statusEntry.status,
    statusLabel: statusEntry.label,
    result: statusEntry.result,
  };
}

function readCompletionStatus(status: JsonObject):
  | {
      status: CodexNativeSubagentCompletionStatus;
      label: string;
      result: string;
    }
  | undefined {
  for (const [rawKey, value] of Object.entries(status)) {
    const normalized = normalizeStatusKey(rawKey);
    const mappedStatus = mapCompletionStatus(normalized);
    if (!mappedStatus) {
      continue;
    }
    return {
      status: mappedStatus,
      label: rawKey,
      result: stringifyResult(value),
    };
  }
  return undefined;
}

function mapCompletionStatus(value: string): CodexNativeSubagentCompletionStatus | undefined {
  if (value === "completed" || value === "succeeded" || value === "success") {
    return "succeeded";
  }
  if (
    value === "cancelled" ||
    value === "canceled" ||
    value === "interrupted" ||
    value === "shutdown"
  ) {
    return "cancelled";
  }
  if (
    value === "failed" ||
    value === "error" ||
    value === "errored" ||
    value === "systemerror" ||
    value === "notfound"
  ) {
    return "failed";
  }
  return undefined;
}

function stringifyResult(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value.trim() || "(no output)";
  }
  if (value === null || value === undefined) {
    return "(no output)";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "(unserializable output)";
  }
}

function readTrustedInterAgentCommunicationContent(item: JsonObject): string | undefined {
  const communication = readTrustedInterAgentCommunication(item);
  return communication ? readString(communication, "content") : undefined;
}

function readTrustedInterAgentCommunicationAuthor(item: JsonObject): string | undefined {
  const communication = readTrustedInterAgentCommunication(item);
  return communication ? readString(communication, "author") : undefined;
}

function readTrustedInterAgentCommunication(item: JsonObject): JsonObject | undefined {
  if (
    readString(item, "type") !== "message" ||
    readString(item, "role") !== "assistant" ||
    readString(item, "phase") !== "commentary"
  ) {
    return undefined;
  }
  const text = extractSingleTextPart(item);
  if (!text) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  if (
    !readString(parsed, "author") ||
    !readString(parsed, "recipient") ||
    !readString(parsed, "content") ||
    readValue(parsed, "trigger_turn") !== false
  ) {
    return undefined;
  }
  return parsed;
}

function extractSingleTextPart(item: JsonObject): string | undefined {
  const content = readValue(item, "content");
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const [entry] = content;
  if (!isJsonObject(entry)) {
    return undefined;
  }
  const type = readString(entry, "type");
  if (type !== "output_text" && type !== "text") {
    return undefined;
  }
  return readString(entry, "text")?.trim();
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function readJsonObject(record: object, key: string): JsonObject | undefined {
  const value = readValue(record, key);
  return isJsonObject(value) ? value : undefined;
}

function readValue(record: object, key: string): unknown {
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeStatusKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
