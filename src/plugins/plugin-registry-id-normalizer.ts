import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

export type PluginRegistryIdNormalizerOptions = {
  manifestRegistry?: PluginManifestRegistry;
  lookUpTable?: Pick<{ manifestRegistry: PluginManifestRegistry }, "manifestRegistry">;
};

const MAX_PLUGIN_REGISTRY_ALIAS_LIST_ENTRIES = 10_000;

function normalizePluginRegistryAlias(value: string): string {
  return value.trim();
}

function normalizePluginRegistryAliasKey(value: string): string {
  return normalizePluginRegistryAlias(value).toLowerCase();
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const safeLength = Math.min(Math.max(0, length), MAX_PLUGIN_REGISTRY_ALIAS_LIST_ENTRIES);
  const entries: unknown[] = [];
  for (let index = 0; index < safeLength; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      entries.push(undefined);
    }
  }
  return entries;
}

function copyStringArrayEntries(value: unknown): string[] {
  return copyArrayEntries(value).filter((entry): entry is string => typeof entry === "string");
}

function collectObjectKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function readPluginId(plugin: unknown): string | undefined {
  const id = readRecordValue(plugin, "id");
  return typeof id === "string" ? id : undefined;
}

function copyManifestRecords(registry: PluginManifestRegistry): PluginManifestRecord[] {
  return copyArrayEntries(readRecordValue(registry, "plugins")).filter(
    (plugin): plugin is PluginManifestRecord => !!plugin && typeof plugin === "object",
  );
}

function listPluginRegistryNormalizerAliases(plugin: PluginManifestRecord): readonly string[] {
  const setup = readRecordValue(plugin, "setup");
  const modelCatalog = readRecordValue(plugin, "modelCatalog");
  return [
    readPluginId(plugin),
    ...copyStringArrayEntries(readRecordValue(plugin, "providers")),
    ...copyStringArrayEntries(readRecordValue(plugin, "channels")),
    ...copyArrayEntries(readRecordValue(setup, "providers")).map((provider) =>
      readRecordValue(provider, "id"),
    ),
    ...copyStringArrayEntries(readRecordValue(plugin, "cliBackends")),
    ...copyStringArrayEntries(readRecordValue(setup, "cliBackends")),
    ...collectObjectKeys(readRecordValue(modelCatalog, "providers")),
    ...collectObjectKeys(readRecordValue(modelCatalog, "aliases")),
    ...copyStringArrayEntries(readRecordValue(plugin, "legacyPluginIds")),
  ].filter((alias): alias is string => typeof alias === "string");
}

export function createPluginRegistryIdNormalizer(
  index: InstalledPluginIndex,
  options: PluginRegistryIdNormalizerOptions = {},
): (pluginId: string) => string {
  const aliases = new Map<string, string>();
  for (const plugin of index.plugins) {
    if (!plugin.pluginId) {
      continue;
    }
    const pluginId = normalizePluginRegistryAlias(plugin.pluginId);
    if (pluginId) {
      aliases.set(normalizePluginRegistryAliasKey(pluginId), plugin.pluginId);
    }
  }
  const registry =
    options.lookUpTable?.manifestRegistry ??
    options.manifestRegistry ??
    loadPluginManifestRegistryForInstalledIndex({
      index,
      includeDisabled: true,
    });
  for (const plugin of copyManifestRecords(registry).toSorted((left, right) =>
    (readPluginId(left) ?? "").localeCompare(readPluginId(right) ?? ""),
  )) {
    const rawPluginId = readPluginId(plugin);
    if (!rawPluginId) {
      continue;
    }
    const pluginId = normalizePluginRegistryAlias(rawPluginId);
    if (!pluginId) {
      continue;
    }
    aliases.set(normalizePluginRegistryAliasKey(pluginId), rawPluginId);
    for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
      const normalizedAlias = normalizePluginRegistryAlias(alias);
      const normalizedAliasKey = normalizePluginRegistryAliasKey(alias);
      if (normalizedAlias && !aliases.has(normalizedAliasKey)) {
        aliases.set(normalizedAliasKey, pluginId);
      }
    }
  }
  return (pluginId: string) => {
    const trimmed = normalizePluginRegistryAlias(pluginId);
    return aliases.get(normalizePluginRegistryAliasKey(trimmed)) ?? trimmed;
  };
}
