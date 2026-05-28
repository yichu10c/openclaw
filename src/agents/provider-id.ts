import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function normalizeProviderId(provider: string): string {
  return normalizeLowercaseStringOrEmpty(provider);
}

/** Normalize provider ID before manifest-owned auth alias lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderId(provider);
}

function copyRecordEntries<T>(entries: Record<string, T> | undefined): Array<[string, T]> {
  if (!entries) {
    return [];
  }
  let keys: string[] = [];
  try {
    keys = Object.keys(entries);
  } catch {
    return [];
  }
  const copied: Array<[string, T]> = [];
  for (const key of keys) {
    try {
      copied.push([key, entries[key]]);
    } catch {
      // Skip unreadable provider entries; normalized lookup can still use later keys.
    }
  }
  return copied;
}

function copyRecordKeys(entries: Record<string, unknown> | undefined): string[] {
  if (!entries) {
    return [];
  }
  try {
    return Object.keys(entries);
  } catch {
    return [];
  }
}

export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, value] of copyRecordEntries(entries)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  return copyRecordKeys(entries).find((key) => normalizeProviderId(key) === providerKey);
}
