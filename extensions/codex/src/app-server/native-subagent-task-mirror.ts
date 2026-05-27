import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX } from "./native-subagent-task-ids.js";
import type {
  CodexServerNotification,
  CodexSubAgentThreadSpawnSource,
  CodexThread,
  CodexThreadStartedNotification,
  CodexThreadStatus,
  CodexThreadStatusChangedNotification,
  JsonObject,
} from "./protocol.js";
import { isJsonObject } from "./protocol.js";

export type TaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  "createRunningTaskRun" | "recordTaskRunProgressByRunId" | "finalizeTaskRunByRunId"
>;

export type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  agentId?: string;
  now?: () => number;
};

export class CodexNativeSubagentTaskMirror {
  private readonly mirroredThreadIds = new Set<string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly params: CodexNativeSubagentTaskMirrorParams,
    private readonly runtime: TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = readJsonObject(notification, "params");
    if (!params) {
      return;
    }
    if (notification.method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }
    if (notification.method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      this.handleCollabAgentItem(params);
    }
  }

  private handleThreadStarted(params: JsonObject): void {
    const notification = readThreadStartedNotification(params);
    if (!notification) {
      return;
    }
    const thread = notification.thread;
    const spawn = readSubagentThreadSpawnSource(
      readValue(thread, "source"),
      this.params.parentThreadId,
    );
    if (!spawn) {
      return;
    }
    const threadId = readString(thread, "id")?.trim() ?? "";
    if (!threadId || this.mirroredThreadIds.has(threadId)) {
      return;
    }
    this.mirroredThreadIds.add(threadId);
    const runId = codexNativeSubagentRunId(threadId);
    const label =
      trimOptional(readString(spawn, "agent_nickname")) ??
      trimOptional(readString(thread, "agentNickname")) ??
      trimOptional(readString(spawn, "agent_role")) ??
      trimOptional(readString(thread, "agentRole")) ??
      "Codex subagent";
    const task =
      trimOptional(readString(thread, "preview")) ??
      `Codex native subagent${label === "Codex subagent" ? "" : ` ${label}`}`;
    const createdAt = secondsToMillis(readValue(thread, "createdAt")) ?? this.now();
    this.runtime.createRunningTaskRun({
      sourceId: runId,
      agentId: this.params.agentId,
      runId,
      label,
      task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: this.now(),
      progressSummary: "Codex native subagent started.",
    });
    this.applyStatus(threadId, readJsonObject(thread, "status") as CodexThreadStatus | undefined);
  }

  private handleThreadStatusChanged(params: JsonObject): void {
    const notification = readThreadStatusChangedNotification(params);
    if (!notification) {
      return;
    }
    this.applyStatus(notification.threadId, notification.status);
  }

  private applyStatus(threadId: string, status: CodexThreadStatus | null | undefined): void {
    if (!status || typeof status !== "object") {
      return;
    }
    const statusType = readValue(status, "type");
    if (!isCodexThreadStatusType(statusType)) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    if (this.terminalRunIds.has(runId) && statusType !== "systemError") {
      return;
    }
    const eventAt = this.now();
    if (statusType === "active") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is active.",
      });
      return;
    }
    if (statusType === "idle") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is idle.",
        terminalSummary: "Codex native subagent finished.",
      });
      return;
    }
    if (statusType === "systemError") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "failed",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: "Codex app-server reported a system error for the native subagent thread.",
        progressSummary: "Codex native subagent hit a system error.",
        terminalSummary: "Codex native subagent failed.",
      });
      return;
    }
    if (statusType === "notLoaded") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is not loaded.",
      });
    }
  }

  private handleCollabAgentItem(params: JsonObject): void {
    const item = readJsonObject(params, "item");
    if (!item || readString(item, "type") !== "collabAgentToolCall") {
      return;
    }
    const senderThreadId = readString(item, "senderThreadId") ?? readString(params, "threadId");
    if (senderThreadId !== this.params.parentThreadId) {
      return;
    }
    const isSpawnAgentTool = normalizeToolName(readString(item, "tool")) === "spawnagent";
    const receiverThreadIds = readStringArray(readValue(item, "receiverThreadIds"));
    const agentsStates = readAgentsStates(readValue(item, "agentsStates"));
    const spawnChildThreadIds = new Set([...receiverThreadIds, ...agentsStates.keys()]);
    if (isSpawnAgentTool) {
      for (const childThreadId of spawnChildThreadIds) {
        this.createTaskFromCollabSpawnItem(childThreadId, item);
      }
    }
    const toolCallStatus = normalizeCollabToolCallStatus(readString(item, "status"));
    const terminalToolCallThreadIds = new Set<string>();
    if (isSpawnAgentTool && isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) {
      for (const threadId of spawnChildThreadIds) {
        terminalToolCallThreadIds.add(threadId);
      }
      for (const threadId of agentsStates.keys()) {
        terminalToolCallThreadIds.add(threadId);
      }
    }
    const terminalAgentStateThreadIds = new Set<string>();
    for (const [threadId, state] of agentsStates) {
      const normalizedStatus = normalizeAgentStateStatus(state.status);
      if (
        terminalToolCallThreadIds.has(threadId) &&
        isNonTerminalAgentStateStatus(normalizedStatus)
      ) {
        continue;
      }
      this.applyCollabAgentStatus(threadId, normalizedStatus, state.message);
      if (isTerminalAgentStateStatus(normalizedStatus)) {
        terminalAgentStateThreadIds.add(threadId);
      }
    }
    if (isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) {
      for (const threadId of terminalToolCallThreadIds) {
        if (terminalAgentStateThreadIds.has(threadId)) {
          continue;
        }
        const state = agentsStates.get(threadId);
        this.applyCollabAgentStatus(threadId, toolCallStatus, state?.message);
      }
    }
  }

  private createTaskFromCollabSpawnItem(threadId: string, item: JsonObject): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || this.mirroredThreadIds.has(normalizedThreadId)) {
      return;
    }
    this.mirroredThreadIds.add(normalizedThreadId);
    const prompt = trimOptional(readString(item, "prompt"));
    const runId = codexNativeSubagentRunId(normalizedThreadId);
    const createdAt = this.now();
    this.runtime.createRunningTaskRun({
      sourceId: runId,
      agentId: this.params.agentId,
      runId,
      label: "Codex subagent",
      task: prompt ?? "Codex native subagent",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: createdAt,
      progressSummary: "Codex native subagent spawned.",
    });
  }

  private applyCollabAgentStatus(
    threadId: string,
    status: string | undefined,
    message: string | null | undefined,
  ): void {
    const normalizedStatus = normalizeAgentStateStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    if (this.terminalRunIds.has(runId) && isNonTerminalAgentStateStatus(normalizedStatus)) {
      return;
    }
    const eventAt = this.now();
    if (normalizedStatus === "pendingInit" || normalizedStatus === "running") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary:
          trimOptional(message) ??
          (normalizedStatus === "pendingInit"
            ? "Codex native subagent is initializing."
            : "Codex native subagent is running."),
      });
      return;
    }
    if (normalizedStatus === "completed") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: trimOptional(message) ?? "Codex native subagent completed.",
        terminalSummary: trimOptional(message) ?? "Codex native subagent finished.",
      });
      return;
    }
    if (normalizedStatus === "blocked") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: trimOptional(message) ?? "Codex native subagent blocked.",
        terminalSummary: trimOptional(message) ?? "Codex native subagent blocked.",
        terminalOutcome: "blocked",
      });
      return;
    }
    this.terminalRunIds.add(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      status:
        normalizedStatus === "interrupted" || normalizedStatus === "shutdown"
          ? "cancelled"
          : "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: trimOptional(message) ?? `Codex native subagent status: ${normalizedStatus}`,
      progressSummary: trimOptional(message) ?? `Codex native subagent ${normalizedStatus}.`,
      terminalSummary: trimOptional(message) ?? "Codex native subagent did not complete.",
    });
  }
}

export function codexNativeSubagentRunId(threadId: string): string {
  return `${CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX}${threadId.trim()}`;
}

export function readSubagentThreadSpawnSource(
  source: unknown,
  parentThreadId: string,
): CodexSubAgentThreadSpawnSource | undefined {
  const sourceObject = isJsonObject(source) ? source : undefined;
  const subAgent = sourceObject ? readJsonObject(sourceObject, "subAgent") : undefined;
  if (!subAgent) {
    return undefined;
  }
  const spawn = readJsonObject(subAgent, "thread_spawn");
  if (!spawn) {
    return undefined;
  }
  return readString(spawn, "parent_thread_id") === parentThreadId
    ? (spawn as CodexSubAgentThreadSpawnSource)
    : undefined;
}

function readThreadStartedNotification(
  params: JsonObject,
): CodexThreadStartedNotification | undefined {
  const thread = readJsonObject(params, "thread");
  if (!thread || !readString(thread, "id")) {
    return undefined;
  }
  return { thread: thread as CodexThread };
}

function readThreadStatusChangedNotification(
  params: JsonObject,
): CodexThreadStatusChangedNotification | undefined {
  const threadId = readString(params, "threadId");
  if (!threadId) {
    return undefined;
  }
  const status = readJsonObject(params, "status");
  if (!status || !isCodexThreadStatusType(readValue(status, "type"))) {
    return undefined;
  }
  return {
    threadId,
    status: status as CodexThreadStatus,
  };
}

function isCodexThreadStatusType(value: unknown): value is CodexThreadStatus["type"] {
  return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}

function readAgentsStates(
  value: unknown,
): Map<string, { status?: string; message?: string | null }> {
  const states = new Map<string, { status?: string; message?: string | null }>();
  for (const [threadId, rawState] of readObjectEntries(value)) {
    if (!isJsonObject(rawState)) {
      continue;
    }
    const status = readString(rawState, "status");
    const message = readNullableString(rawState, "message");
    states.set(threadId, { status, message });
  }
  return states;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readString(value: JsonObject, key: string): string | undefined {
  const entry = readValue(value, key);
  return typeof entry === "string" ? entry : undefined;
}

function readNullableString(value: JsonObject, key: string): string | null | undefined {
  const entry = readValue(value, key);
  return typeof entry === "string" || entry === null ? entry : undefined;
}

function readJsonObject(record: object, key: string): JsonObject | undefined {
  const value = readValue(record, key);
  return isJsonObject(value) ? value : undefined;
}

function readObjectEntries(value: unknown): Array<[string, unknown]> {
  if (!isJsonObject(value)) {
    return [];
  }
  try {
    return Object.entries(value);
  } catch {
    return [];
  }
}

function readValue(record: object, key: string): unknown {
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function normalizeCollabToolCallStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "failed" || key === "error" || key === "errored") {
    return "failed";
  }
  if (key === "blocked" || key === "declined") {
    return "blocked";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  return value?.trim();
}

function isBlockedOrFailedCollabToolCallStatus(value: string | undefined): boolean {
  return value === "failed" || value === "blocked";
}

function isNonTerminalAgentStateStatus(value: string | undefined): boolean {
  return value === "pendingInit" || value === "running";
}

function isTerminalAgentStateStatus(value: string | undefined): boolean {
  return value !== undefined && !isNonTerminalAgentStateStatus(value);
}

function normalizeAgentStateStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!key) {
    return undefined;
  }
  if (key === "pendinginit") {
    return "pendingInit";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") {
    return key === "shutdown" ? "shutdown" : "interrupted";
  }
  if (key === "failed" || key === "error" || key === "systemerror") {
    return "failed";
  }
  if (key === "blocked" || key === "declined") {
    return "blocked";
  }
  return value?.trim();
}

function secondsToMillis(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * 1000;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
