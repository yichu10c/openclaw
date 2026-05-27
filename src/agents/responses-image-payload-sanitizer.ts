import { canonicalizeBase64 } from "../media/base64.js";
import { isRecord } from "../shared/record-coerce.js";

const DATA_URL_PREFIX = "data:";
const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";
const CIRCULAR_OMITTED_TEXT = "omitted image payload: circular reference";
const NON_JSON_OMITTED_TEXT = "omitted image payload: non-JSON-compatible value";
const UNREADABLE_OMITTED_TEXT = "omitted image payload: unreadable payload";

type JsonRecord = Record<string, unknown>;
type SanitizeContext = "value" | "input-array" | "input-item" | "content-entry";

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, DATA_URL_PREFIX.length).toLowerCase() === DATA_URL_PREFIX;
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  return undefined;
}

function sanitizeImageUrl(imageUrl: string): string | undefined {
  if (!startsWithDataUrl(imageUrl)) {
    return imageUrl;
  }
  const commaIndex = imageUrl.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }

  const metadata = imageUrl.slice(DATA_URL_PREFIX.length, commaIndex);
  const payload = imageUrl.slice(commaIndex + 1);
  const metadataParts = metadata.split(";").map((part) => part.trim());
  const declaredMimeType = metadataParts[0]?.toLowerCase();
  if (!declaredMimeType?.startsWith("image/")) {
    return undefined;
  }
  if (!metadataParts.slice(1).some((part) => part.toLowerCase() === "base64")) {
    return undefined;
  }

  const canonicalPayload = canonicalizeBase64(payload);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffImageMime(Buffer.from(canonicalPayload, "base64"));
  if (!sniffedMimeType) {
    return undefined;
  }
  return `data:${sniffedMimeType};base64,${canonicalPayload}`;
}

function invalidSnakeImage(): JsonRecord {
  return omittedPayload(IMAGE_OMITTED_TEXT);
}

function omittedText(text: string): string {
  return `[${text}]`;
}

function omittedPayload(text: string): JsonRecord {
  return { type: "input_text", text: omittedText(text) };
}

function shouldOmitObjectField(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

function omittedInputItem(text: string): JsonRecord {
  return {
    type: "message",
    role: "user",
    content: [omittedPayload(text)],
  };
}

function omittedEntry(context: SanitizeContext, text: string): JsonRecord | string {
  return context === "input-item" ? omittedInputItem(text) : omittedPayload(text);
}

function sanitizeValue(
  value: unknown,
  stack = new WeakSet<object>(),
  context: SanitizeContext = "value",
): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    if (context === "input-item" || context === "content-entry") {
      return omittedEntry(context, NON_JSON_OMITTED_TEXT);
    }
    return omittedText(NON_JSON_OMITTED_TEXT);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return omittedEntry(context, CIRCULAR_OMITTED_TEXT);
    }
    stack.add(value);
    try {
      const next: unknown[] = [];
      const entryContext = context === "input-array" ? "input-item" : "content-entry";
      for (let index = 0; index < value.length; index += 1) {
        try {
          next.push(sanitizeValue(value[index], stack, entryContext));
        } catch {
          next.push(omittedEntry(entryContext, UNREADABLE_OMITTED_TEXT));
        }
      }
      return next;
    } finally {
      stack.delete(value);
    }
  }
  if (!isRecord(value)) {
    return value;
  }
  if (stack.has(value)) {
    return omittedEntry(context, CIRCULAR_OMITTED_TEXT);
  }

  stack.add(value);
  try {
    const type = value.type;
    const rawImageUrl = value.image_url;
    if (type === "input_image" && typeof rawImageUrl === "string") {
      const imageUrl = sanitizeImageUrl(rawImageUrl);
      if (!imageUrl) {
        return invalidSnakeImage();
      }

      const next: JsonRecord = {};
      for (const [key, child] of Object.entries(value)) {
        if (shouldOmitObjectField(child)) {
          continue;
        }
        next[key] = key === "image_url" ? imageUrl : sanitizeValue(child, stack);
      }
      return next;
    }

    const next: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (shouldOmitObjectField(child)) {
        continue;
      }
      next[key] = sanitizeValue(child, stack);
    }
    return next;
  } catch {
    return omittedEntry(context, UNREADABLE_OMITTED_TEXT);
  } finally {
    stack.delete(value);
  }
}

export function sanitizeResponsesImagePayload<T extends Record<string, unknown>>(params: T): T {
  if (!Array.isArray(params.input)) {
    return params;
  }
  return {
    ...params,
    input: sanitizeValue(params.input, new WeakSet(), "input-array"),
  };
}

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  return sanitizeImageUrl(imageUrl);
}

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}
