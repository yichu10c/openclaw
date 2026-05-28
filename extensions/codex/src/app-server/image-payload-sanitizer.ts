import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const DATA_URL_PREFIX = "data:";
const IMAGE_OMITTED_TEXT = "omitted image payload: invalid inline image data";
const IMAGE_SIGNATURES: Array<{
  mime: string;
  matches: (buffer: Buffer) => boolean;
}> = [
  {
    mime: "image/png",
    matches: (buffer) =>
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    matches: (buffer) =>
      buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mime: "image/webp",
    matches: (buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
  },
  {
    mime: "image/gif",
    matches: (buffer) =>
      buffer.length >= 6 &&
      (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a"),
  },
];

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, DATA_URL_PREFIX.length).toLowerCase() === DATA_URL_PREFIX;
}

function canonicalizeBase64(base64: string): string | undefined {
  let cleaned = "";
  let padding = 0;
  let sawPadding = false;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      cleaned += "=";
      continue;
    }
    const isBase64DataChar =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (sawPadding || !isBase64DataChar) {
      return undefined;
    }
    cleaned += base64[i];
  }
  if (!cleaned || cleaned.length % 4 !== 0) {
    return undefined;
  }
  return cleaned;
}

function sniffImageMime(buffer: Buffer): string | undefined {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(buffer))?.mime;
}

function parseImageDataUrl(value: string):
  | {
      metadata: string[];
      payload: string;
    }
  | undefined {
  if (!startsWithDataUrl(value)) {
    return { metadata: [], payload: value };
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  return {
    metadata: value
      .slice(DATA_URL_PREFIX.length, commaIndex)
      .split(";")
      .map((part) => part.trim()),
    payload: value.slice(commaIndex + 1),
  };
}

function metadataAllowsImageBase64(metadata: string[]): boolean {
  const [mimeType, ...options] = metadata;
  const isImageMimeType = mimeType !== undefined && mimeType.toLowerCase().startsWith("image/");
  return isImageMimeType && options.some((part) => part.toLowerCase() === "base64");
}

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

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
      // Mirrored history can include synthetic plugin objects with throwing
      // getters. Drop unreadable fields before image sanitation recurses.
    }
  }
  return entries;
}

function cloneReadableRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(readableRecordEntries(record));
}

function hasOwnReadableKey(record: Record<string, unknown>, key: string): boolean {
  try {
    return Object.hasOwn(record, key);
  } catch {
    return false;
  }
}

export function sanitizeInlineImageDataUrl(imageUrl: string): string | undefined {
  const parsed = parseImageDataUrl(imageUrl);
  if (!parsed) {
    return undefined;
  }
  if (parsed.metadata.length === 0) {
    return imageUrl;
  }
  if (!metadataAllowsImageBase64(parsed.metadata)) {
    return undefined;
  }

  const canonicalPayload = canonicalizeBase64(parsed.payload);
  if (!canonicalPayload) {
    return undefined;
  }
  const sniffedMimeType = sniffImageMime(Buffer.from(canonicalPayload, "base64"));
  if (!sniffedMimeType) {
    return undefined;
  }
  return `data:${sniffedMimeType};base64,${canonicalPayload}`;
}

export function invalidInlineImageText(label: string): string {
  return `[${label}] ${IMAGE_OMITTED_TEXT}`;
}

function sanitizeImageContentRecord(
  record: Record<string, unknown>,
  label: string,
): Record<string, unknown> | undefined {
  const type = readRecordValue(record, "type");
  if (type === "image") {
    if (!hasOwnReadableKey(record, "data")) {
      return undefined;
    }
    const data = readRecordValue(record, "data");
    if (typeof data !== "string") {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const rawMimeType = readRecordValue(record, "mimeType");
    const mimeType = typeof rawMimeType === "string" ? rawMimeType : "image/png";
    const imageUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${data}`);
    if (!imageUrl) {
      return { type: "text", text: invalidInlineImageText(label) };
    }
    const commaIndex = imageUrl.indexOf(",");
    const metadata = imageUrl.slice(DATA_URL_PREFIX.length, commaIndex);
    const mime = metadata.split(";")[0] ?? mimeType;
    return { ...cloneReadableRecord(record), mimeType: mime, data: imageUrl.slice(commaIndex + 1) };
  }

  const imageUrlValue = readRecordValue(record, "imageUrl");
  if (type === "inputImage") {
    if (typeof imageUrlValue !== "string") {
      return { type: "inputText", text: invalidInlineImageText(label) };
    }
    const imageUrl = sanitizeInlineImageDataUrl(imageUrlValue);
    return imageUrl
      ? { ...cloneReadableRecord(record), imageUrl }
      : { type: "inputText", text: invalidInlineImageText(label) };
  }

  const imageUrlSnakeValue = readRecordValue(record, "image_url");
  if (type === "input_image") {
    if (typeof imageUrlSnakeValue !== "string") {
      return { type: "input_text", text: invalidInlineImageText(label) };
    }
    const imageUrl = sanitizeInlineImageDataUrl(imageUrlSnakeValue);
    return imageUrl
      ? { ...cloneReadableRecord(record), image_url: imageUrl }
      : { type: "input_text", text: invalidInlineImageText(label) };
  }

  return undefined;
}

export function sanitizeCodexHistoryImagePayloads<T>(value: T, label: string): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCodexHistoryImagePayloads(entry, label)) as T;
  }
  if (!isRecord(value)) {
    return value;
  }

  const imageRecord = sanitizeImageContentRecord(value, label);
  if (imageRecord) {
    return imageRecord as T;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of readableRecordEntries(value)) {
    next[key] = sanitizeCodexHistoryImagePayloads(child, label);
  }
  return next as T;
}
