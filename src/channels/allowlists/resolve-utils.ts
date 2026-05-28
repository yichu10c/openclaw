import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { RuntimeEnv } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { summarizeStringEntries } from "../../shared/string-sample.js";

export type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};

type SafeResolutionEntry<T extends AllowlistUserResolutionLike> = {
  entry: T;
  input: string;
  resolved: boolean;
  id?: string;
};

function copyArrayEntries<T>(value: readonly T[] | undefined): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length = 0;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: T[] = [];
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
      // Treat unreadable allowlist entries as absent; later entries can still be repaired.
    }
  }
  return entries;
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function copyRecordEntries<T>(value: Record<string, T>): Array<[string, T]> {
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, T]> = [];
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      // Skip unreadable channel/room config entries; readable siblings can still be patched.
    }
  }
  return entries;
}

function normalizeStringSafely(value: unknown): string {
  try {
    return normalizeOptionalString(value) ?? "";
  } catch {
    return "";
  }
}

function readSafeResolutionEntry<T extends AllowlistUserResolutionLike>(
  entry: T | undefined,
): SafeResolutionEntry<T> | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const input = normalizeStringSafely(readRecordValue(entry, "input"));
  if (!input) {
    return null;
  }
  const id = normalizeStringSafely(readRecordValue(entry, "id")) || undefined;
  return {
    entry,
    input,
    resolved: readRecordValue(entry, "resolved") === true,
    id,
  };
}

function formatResolutionEntry<T extends AllowlistUserResolutionLike>(
  safeEntry: SafeResolutionEntry<T>,
  formatter: (entry: T) => string,
  fallback: string,
): string {
  try {
    return normalizeOptionalString(formatter(safeEntry.entry)) ?? fallback;
  } catch {
    return fallback;
  }
}

function dedupeAllowlistEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of copyArrayEntries(entries)) {
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  return dedupeAllowlistEntries([
    ...mapAllowFromEntries(params.existing),
    ...copyArrayEntries(params.additions),
  ]);
}

export function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(
  resolvedUsers: T[],
  opts?: { formatResolved?: (entry: T) => string; formatUnresolved?: (entry: T) => string },
): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
  additions: string[];
} {
  const safeEntries = copyArrayEntries(resolvedUsers)
    .map(readSafeResolutionEntry)
    .filter((entry): entry is SafeResolutionEntry<T> => Boolean(entry));
  const resolvedMap = new Map(safeEntries.map((entry) => [entry.input, entry.entry]));
  const resolvedOk = (entry: SafeResolutionEntry<T>) => Boolean(entry.resolved && entry.id);
  const formatResolved = opts?.formatResolved ?? ((entry: T) => `${entry.input}→${entry.id}`);
  const formatUnresolved = opts?.formatUnresolved ?? ((entry: T) => entry.input);
  const mapping = safeEntries
    .filter(resolvedOk)
    .map((entry) => formatResolutionEntry(entry, formatResolved, `${entry.input}→${entry.id}`));
  const additions = safeEntries
    .filter(resolvedOk)
    .map((entry) => entry.id)
    .filter((entry): entry is string => Boolean(entry));
  const unresolved = safeEntries
    .filter((entry) => !resolvedOk(entry))
    .map((entry) => formatResolutionEntry(entry, formatUnresolved, entry.input));
  return { resolvedMap, mapping, unresolved, additions };
}

function resolveAllowlistIdAdditions<T extends AllowlistUserResolutionLike>(params: {
  existing: Array<string | number>;
  resolvedMap: Map<string, T>;
}): string[] {
  const additions: string[] = [];
  for (const entry of copyArrayEntries(params.existing)) {
    const trimmed = normalizeStringSafely(entry);
    const resolved = params.resolvedMap.get(trimmed);
    const safeResolved = readSafeResolutionEntry(resolved);
    if (safeResolved?.resolved && safeResolved.id) {
      additions.push(safeResolved.id);
    }
  }
  return additions;
}

export function canonicalizeAllowlistWithResolvedIds<
  T extends AllowlistUserResolutionLike,
>(params: { existing?: Array<string | number>; resolvedMap: Map<string, T> }): string[] {
  const canonicalized: string[] = [];
  for (const entry of copyArrayEntries(params.existing)) {
    const trimmed = normalizeStringSafely(entry);
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      canonicalized.push(trimmed);
      continue;
    }
    const resolved = params.resolvedMap.get(trimmed);
    const safeResolved = readSafeResolutionEntry(resolved);
    canonicalized.push(safeResolved?.resolved && safeResolved.id ? safeResolved.id : trimmed);
  }
  return dedupeAllowlistEntries(canonicalized);
}

export function patchAllowlistUsersInConfigEntries<
  T extends AllowlistUserResolutionLike,
  TEntries extends Record<string, unknown>,
>(params: {
  entries: TEntries;
  resolvedMap: Map<string, T>;
  strategy?: "merge" | "canonicalize";
}): TEntries {
  const nextEntries: Record<string, unknown> = Object.fromEntries(
    copyRecordEntries(params.entries),
  );
  for (const [entryKey, entryConfig] of copyRecordEntries(params.entries)) {
    if (!entryConfig || typeof entryConfig !== "object") {
      continue;
    }
    const users = readRecordValue(entryConfig, "users") as Array<string | number> | undefined;
    const userEntries = copyArrayEntries(users);
    if (userEntries.length === 0) {
      continue;
    }
    const resolvedUsers =
      params.strategy === "canonicalize"
        ? canonicalizeAllowlistWithResolvedIds({
            existing: userEntries,
            resolvedMap: params.resolvedMap,
          })
        : mergeAllowlist({
            existing: userEntries,
            additions: resolveAllowlistIdAdditions({
              existing: userEntries,
              resolvedMap: params.resolvedMap,
            }),
          });
    nextEntries[entryKey] = {
      ...Object.fromEntries(copyRecordEntries(entryConfig as Record<string, unknown>)),
      users: resolvedUsers,
    };
  }
  return nextEntries as TEntries;
}

export function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void {
  if (!entry || typeof entry !== "object") {
    return;
  }
  const users = readRecordValue(entry, "users") as Array<string | number> | undefined;
  if (!Array.isArray(users)) {
    return;
  }
  for (const value of copyArrayEntries(users)) {
    const trimmed = normalizeStringSafely(value);
    if (trimmed && trimmed !== "*") {
      target.add(trimmed);
    }
  }
}

export function summarizeMapping(
  label: string,
  mapping: string[],
  unresolved: string[],
  runtime: RuntimeEnv,
): void {
  const lines: string[] = [];
  const resolvedEntries = copyArrayEntries(mapping);
  const unresolvedEntries = copyArrayEntries(unresolved);
  if (resolvedEntries.length > 0) {
    lines.push(
      `${label} resolved: ${summarizeStringEntries({ entries: resolvedEntries, limit: 6 })}`,
    );
  }
  if (unresolvedEntries.length > 0) {
    lines.push(
      `${label} unresolved: ${summarizeStringEntries({ entries: unresolvedEntries, limit: 6 })}`,
    );
  }
  if (lines.length > 0) {
    runtime.log?.(lines.join("\n"));
  }
}
