import { describe, expect, it, vi } from "vitest";
import {
  applyCodexTurnNotificationState,
  isTerminalCodexTurnNotificationForTurn,
  reportCodexExecutionNotification,
} from "./attempt-notification-state.js";
import type { CodexAttemptTurnWatchController } from "./attempt-turn-watches.js";
import type { CodexServerNotification } from "./protocol.js";

function defineThrowingProperty(record: Record<string, unknown>, key: string, message: string) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
}

function createUnreadableParamsNotification(method: string): CodexServerNotification {
  const notification = { method };
  defineThrowingProperty(notification, "params", "fuzzplugin notification state read failed");
  return notification as never;
}

function createTurnWatches(): CodexAttemptTurnWatchController {
  return {
    armAssistantCompletionIdleWatch: vi.fn(),
    armCompletionIdleWatch: vi.fn(),
    disarmAssistantCompletionIdleWatch: vi.fn(),
    disarmCompletionIdleWatch: vi.fn(),
    isAssistantCompletionIdleWatchArmed: vi.fn(() => false),
    isCompletionIdleWatchArmed: vi.fn(() => false),
    isCompletionIdleWatchPinnedByTerminalError: vi.fn(() => false),
    touchActivity: vi.fn(),
  } as never;
}

describe("Codex attempt notification state", () => {
  it("ignores unreadable synthetic execution notification params", () => {
    const emitExecutionPhaseOnce = vi.fn();

    expect(() =>
      reportCodexExecutionNotification({
        notification: createUnreadableParamsNotification("item/started"),
        emitExecutionPhaseOnce,
      }),
    ).not.toThrow();
    expect(emitExecutionPhaseOnce).not.toHaveBeenCalled();
  });

  it("treats unreadable synthetic terminal notification params as non-terminal", () => {
    expect(
      isTerminalCodexTurnNotificationForTurn({
        notification: createUnreadableParamsNotification("turn/completed"),
        threadId: "thread-1",
        turnId: "turn-1",
        currentPromptTexts: [],
      }),
    ).toBe(false);
  });

  it("ignores unreadable synthetic notification params while applying turn state", () => {
    const result = applyCodexTurnNotificationState({
      notification: createUnreadableParamsNotification("error"),
      threadId: "thread-1",
      turnId: "turn-1",
      currentPromptTexts: [],
      sourceReplyDeliveryMode: undefined,
      turnWatches: createTurnWatches(),
      activeTurnItemIds: new Set(),
      activeAppServerTurnRequests: 0,
      pendingOpenClawDynamicToolCompletionIds: new Set(),
      turnCrossedToolHandoff: false,
      postToolRawAssistantCompletionIdleTimeoutMs: 100,
      onScheduleTerminalDynamicToolReleaseCheck: vi.fn(),
      onReportExecutionNotification: vi.fn(),
    });

    expect(result).toEqual({
      isCurrentTurnNotification: false,
      isTurnAbortMarker: false,
      isTurnTerminal: false,
      turnCrossedToolHandoff: false,
    });
  });
});
