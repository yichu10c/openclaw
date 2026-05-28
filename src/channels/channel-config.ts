import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeUniqueSingleOrTrimmedStringList } from "../shared/string-normalization.js";

export type ChannelMatchSource = "direct" | "parent" | "wildcard";

export type ChannelEntryMatch<T> = {
  entry?: T;
  key?: string;
  wildcardEntry?: T;
  wildcardKey?: string;
  parentEntry?: T;
  parentKey?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

type RecordEntryRead<T> =
  | { exists: false; readable: false }
  | { exists: true; readable: true; entry: T }
  | { exists: true; readable: false };

function copyStringKeys(keys: readonly string[] | undefined): string[] {
  if (!Array.isArray(keys)) {
    return [];
  }
  let length = 0;
  try {
    length = keys.length;
  } catch {
    return [];
  }
  const copied: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let hasEntry = true;
    try {
      hasEntry = index in keys;
    } catch {
      hasEntry = true;
    }
    if (!hasEntry) {
      continue;
    }
    try {
      const key = keys[index];
      if (typeof key === "string") {
        copied.push(key);
      }
    } catch {
      // Treat unreadable key candidates as absent; later candidates can still match.
    }
  }
  return copied;
}

function readRecordEntry<T>(
  entries: Record<string, T> | undefined,
  key: string,
): RecordEntryRead<T> {
  if (!entries || typeof entries !== "object") {
    return { exists: false, readable: false };
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) {
      return { exists: false, readable: false };
    }
  } catch {
    return { exists: true, readable: false };
  }
  try {
    return { exists: true, readable: true, entry: entries[key] };
  } catch {
    return { exists: true, readable: false };
  }
}

function copyRecordKeys<T>(entries: Record<string, T> | undefined): string[] {
  if (!entries || typeof entries !== "object") {
    return [];
  }
  try {
    return Object.keys(entries);
  } catch {
    return [];
  }
}

function normalizeKeySafely(normalizeKey: (value: string) => string, value: string): string {
  try {
    return normalizeKey(value);
  } catch {
    return "";
  }
}

function findNormalizedEntryMatch<T>(params: {
  entries?: Record<string, T>;
  normalizedKeys: readonly string[];
  normalizeKey: (value: string) => string;
}): ChannelEntryMatch<T> | null {
  for (const entryKey of copyRecordKeys(params.entries)) {
    const normalizedEntry = normalizeKeySafely(params.normalizeKey, entryKey);
    if (!normalizedEntry || !params.normalizedKeys.includes(normalizedEntry)) {
      continue;
    }
    const read = readRecordEntry(params.entries, entryKey);
    const match: ChannelEntryMatch<T> = { key: entryKey };
    if (read.exists && read.readable) {
      match.entry = read.entry;
    }
    return match;
  }
  return null;
}

function hasAssignedEntry<T>(match: ChannelEntryMatch<T>): boolean {
  return Object.prototype.hasOwnProperty.call(match, "entry");
}

export function applyChannelMatchMeta<
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(result: TResult, match: ChannelEntryMatch<unknown>): TResult {
  if (match.matchKey && match.matchSource) {
    result.matchKey = match.matchKey;
    result.matchSource = match.matchSource;
  }
  return result;
}

export function resolveChannelMatchConfig<
  TEntry,
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(match: ChannelEntryMatch<TEntry>, resolveEntry: (entry: TEntry) => TResult): TResult | null {
  if (!match.entry) {
    return null;
  }
  return applyChannelMatchMeta(resolveEntry(match.entry), match);
}

export function normalizeChannelSlug(value: string): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildChannelKeyCandidates(...keys: Array<string | undefined | null>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(keys);
}

export function resolveChannelEntryMatch<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T> {
  const match: ChannelEntryMatch<T> = {};
  for (const key of copyStringKeys(params.keys)) {
    const read = readRecordEntry(params.entries, key);
    if (!read.exists) {
      continue;
    }
    match.key = key;
    if (read.readable) {
      match.entry = read.entry;
    }
    break;
  }
  if (match.key && !hasAssignedEntry(match)) {
    return match;
  }
  if (params.wildcardKey) {
    const wildcard = readRecordEntry(params.entries, params.wildcardKey);
    if (!wildcard.exists) {
      return match;
    }
    match.wildcardKey = params.wildcardKey;
    if (wildcard.readable) {
      match.wildcardEntry = wildcard.entry;
    }
  }
  return match;
}

export function resolveChannelEntryMatchWithFallback<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  parentKeys?: string[];
  wildcardKey?: string;
  normalizeKey?: (value: string) => string;
}): ChannelEntryMatch<T> {
  const keys = copyStringKeys(params.keys);
  const direct = resolveChannelEntryMatch({
    entries: params.entries,
    keys,
    wildcardKey: params.wildcardKey,
  });

  if (direct.key) {
    if (!hasAssignedEntry(direct)) {
      return { key: direct.key };
    }
    if (direct.entry) {
      return { ...direct, matchKey: direct.key, matchSource: "direct" };
    }
  }

  const normalizeKey = params.normalizeKey;
  if (normalizeKey) {
    const normalizedKeys = keys.map((key) => normalizeKeySafely(normalizeKey, key)).filter(Boolean);
    if (normalizedKeys.length > 0) {
      const normalizedMatch = findNormalizedEntryMatch({
        entries: params.entries,
        normalizedKeys,
        normalizeKey,
      });
      if (normalizedMatch) {
        return hasAssignedEntry(normalizedMatch)
          ? { ...normalizedMatch, matchKey: normalizedMatch.key, matchSource: "direct" }
          : { key: normalizedMatch.key };
      }
    }
  }

  const parentKeys = copyStringKeys(params.parentKeys);
  if (parentKeys.length > 0) {
    const parent = resolveChannelEntryMatch({ entries: params.entries, keys: parentKeys });
    if (parent.key) {
      if (!hasAssignedEntry(parent)) {
        return { key: parent.key, parentKey: parent.key };
      }
      if (parent.entry) {
        return {
          ...direct,
          entry: parent.entry,
          key: parent.key,
          parentEntry: parent.entry,
          parentKey: parent.key,
          matchKey: parent.key,
          matchSource: "parent",
        };
      }
    }
    if (normalizeKey) {
      const normalizedParentKeys = parentKeys
        .map((key) => normalizeKeySafely(normalizeKey, key))
        .filter(Boolean);
      if (normalizedParentKeys.length > 0) {
        const normalizedParent = findNormalizedEntryMatch({
          entries: params.entries,
          normalizedKeys: normalizedParentKeys,
          normalizeKey,
        });
        if (normalizedParent) {
          if (!hasAssignedEntry(normalizedParent)) {
            return { key: normalizedParent.key, parentKey: normalizedParent.key };
          }
          return {
            ...direct,
            entry: normalizedParent.entry,
            key: normalizedParent.key,
            parentEntry: normalizedParent.entry,
            parentKey: normalizedParent.key,
            matchKey: normalizedParent.key,
            matchSource: "parent",
          };
        }
      }
    }
  }

  if (direct.wildcardEntry && direct.wildcardKey) {
    return {
      ...direct,
      entry: direct.wildcardEntry,
      key: direct.wildcardKey,
      matchKey: direct.wildcardKey,
      matchSource: "wildcard",
    };
  }

  return direct;
}

export function resolveNestedAllowlistDecision(params: {
  outerConfigured: boolean;
  outerMatched: boolean;
  innerConfigured: boolean;
  innerMatched: boolean;
}): boolean {
  if (!params.outerConfigured) {
    return true;
  }
  if (!params.outerMatched) {
    return false;
  }
  if (!params.innerConfigured) {
    return true;
  }
  return params.innerMatched;
}
