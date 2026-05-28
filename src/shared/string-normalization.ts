import { normalizeOptionalLowercaseString, normalizeOptionalString } from "./string-coerce.js";

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length = 0;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let hasEntry = true;
    try {
      hasEntry = index in value;
    } catch {
      hasEntry = true;
    }
    if (!hasEntry) {
      continue;
    }
    try {
      entries.push(value[index]);
    } catch {
      // Unreadable config/list entries are treated as absent.
    }
  }
  return entries;
}

function copyIterableEntries(values?: Iterable<unknown>): unknown[] {
  if (!values) {
    return [];
  }
  if (Array.isArray(values)) {
    return copyArrayEntries(values);
  }
  const entries: unknown[] = [];
  try {
    for (const entry of values) {
      entries.push(entry);
    }
  } catch {
    // Keep entries collected before an optional plugin iterable failed.
  }
  return entries;
}

function normalizeStringEntry(entry: unknown): string {
  try {
    return normalizeOptionalString(String(entry)) ?? "";
  } catch {
    return "";
  }
}

export function normalizeStringEntries(list?: ReadonlyArray<unknown>) {
  const normalized: string[] = [];
  for (const entry of copyArrayEntries(list)) {
    const value = normalizeStringEntry(entry);
    if (value) {
      normalized.push(value);
    }
  }
  return normalized;
}

export function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>) {
  return normalizeStringEntries(list).map((entry) => normalizeOptionalLowercaseString(entry) ?? "");
}

export function uniqueValues<T>(values: Iterable<T>): T[] {
  return [...new Set(copyIterableEntries(values) as T[])];
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return uniqueValues(values);
}

export function sortUniqueStrings(values: Iterable<string>): string[] {
  return uniqueStrings(values).toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function normalizeUniqueStringEntries(values?: Iterable<unknown>): string[] {
  return uniqueStrings(normalizeStringEntries(copyIterableEntries(values)));
}

export function normalizeUniqueStringEntriesLower(values?: Iterable<unknown>): string[] {
  return uniqueStrings(normalizeStringEntriesLower(copyIterableEntries(values)).filter(Boolean));
}

export function normalizeSortedUniqueStringEntries(values?: Iterable<unknown>): string[] {
  return sortUniqueStrings(normalizeUniqueStringEntries(values));
}

export function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of copyArrayEntries(value)) {
    const normalized = normalizeOptionalString(entry);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return entries;
}

export function normalizeUniqueTrimmedStringList(value: unknown): string[] {
  return uniqueStrings(normalizeTrimmedStringList(value));
}

export function normalizeSortedUniqueTrimmedStringList(value: unknown): string[] {
  return sortUniqueStrings(normalizeTrimmedStringList(value));
}

export function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeTrimmedStringList(value);
}

export function normalizeSingleOrTrimmedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeTrimmedStringList(value);
  }
  const normalized = normalizeOptionalString(value);
  return normalized ? [normalized] : [];
}

export function normalizeUniqueSingleOrTrimmedStringList(value: unknown): string[] {
  return uniqueStrings(normalizeSingleOrTrimmedStringList(value));
}

export function normalizeCsvOrLooseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringEntries(value);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSlugInput(raw?: string | null) {
  return (normalizeOptionalLowercaseString(raw) ?? "").normalize("NFC");
}

export function normalizeHyphenSlug(raw?: string | null) {
  const trimmed = normalizeSlugInput(raw);
  if (!trimmed) {
    return "";
  }
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^\p{L}\p{M}\p{N}#@._+-]+/gu, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function normalizeAtHashSlug(raw?: string | null) {
  const trimmed = normalizeSlugInput(raw);
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^[@#]+/, "");
  const dashed = withoutPrefix.replace(/[\s_]+/g, "-");
  const cleaned = dashed.replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
