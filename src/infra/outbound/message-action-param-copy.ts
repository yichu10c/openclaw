import { ToolInputError } from "../../agents/tools/common.js";

const MAX_MESSAGE_ACTION_PARAM_ENTRIES = 10_000;
const MESSAGE_ACTION_FAIL_CLOSED_PARAM_KEYS = new Set([
  "accountId",
  "account_id",
  "action",
  "asDocument",
  "as_document",
  "channel",
  "channelId",
  "channel_id",
  "chatGuid",
  "chatIdentifier",
  "chatId",
  "chat_guid",
  "chat_identifier",
  "chat_id",
  "conversationId",
  "conversation_id",
  "dryRun",
  "dry_run",
  "filePath",
  "fileUrl",
  "file_path",
  "file_url",
  "forceDocument",
  "force_document",
  "idempotencyKey",
  "idempotency_key",
  "media",
  "mediaUrl",
  "media_url",
  "messageId",
  "message_id",
  "path",
  "replyTo",
  "reply_to",
  "sessionId",
  "sessionKey",
  "session_id",
  "session_key",
  "target",
  "threadId",
  "thread_id",
  "to",
  "topLevel",
  "top_level",
  "userId",
  "user_id",
]);

export function copyMessageActionParams(params: Record<string, unknown>): Record<string, unknown> {
  let keys: string[];
  try {
    keys = Object.keys(params);
  } catch {
    throw new ToolInputError("message action params could not be read");
  }
  if (keys.length > MAX_MESSAGE_ACTION_PARAM_ENTRIES) {
    throw new ToolInputError(
      `message action params supports at most ${MAX_MESSAGE_ACTION_PARAM_ENTRIES} entries`,
    );
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    try {
      copy[key] = params[key];
    } catch {
      if (MESSAGE_ACTION_FAIL_CLOSED_PARAM_KEYS.has(key)) {
        throw new ToolInputError(`${key} could not be read`);
      }
      // Unreadable model/plugin-provided action params are treated as absent.
    }
  }
  return copy;
}
