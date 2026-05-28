import { normalizeStringEntries } from "../shared/string-normalization.js";

export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

type NormalizedAllowFrom = {
  entries: string[];
  present: boolean;
  length: number;
};

export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

function normalizeAllowFromEntries(value?: Array<string | number>): NormalizedAllowFrom {
  if (!Array.isArray(value)) {
    return { entries: [], present: false, length: 0 };
  }
  let length = 0;
  try {
    length = value.length;
  } catch {
    return { entries: [], present: true, length: 1 };
  }
  const entries: Array<string | number> = [];
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
      // Explicit but unreadable allowlist entries should not broaden access.
    }
  }
  return { entries: normalizeStringEntries(entries), present: true, length };
}

export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const allowEntries = normalizeAllowFromEntries(params.allowFrom).entries;
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : normalizeAllowFromEntries(params.storeAllowFrom).entries;
  return [...allowEntries, ...storeEntries];
}

export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const groupAllowFrom = normalizeAllowFromEntries(params.groupAllowFrom);
  const scoped =
    groupAllowFrom.present && groupAllowFrom.length > 0
      ? groupAllowFrom.entries
      : params.fallbackToAllowFrom === false
        ? []
        : normalizeAllowFromEntries(params.allowFrom).entries;
  return scoped;
}

export function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
