import type { OpenClawConfig } from "../config/types.js";

type ProviderModelRef = {
  provider: string;
  model: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!isRecord(record)) {
    return undefined;
  }
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      // Skip unreadable provider entries; later configured providers can still be used.
    }
  }
  return entries;
}

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
    try {
      entries.push(value[index]);
    } catch {
      // Ignore unreadable model entries; another configured provider can still be a fallback.
    }
  }
  return entries;
}

function readModelId(model: unknown): string | undefined {
  const id = readRecordValue(model, "id");
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function firstConfiguredModelId(providerCfg: unknown): string | undefined {
  return readModelId(copyArrayEntries(readRecordValue(providerCfg, "models"))[0]);
}

function hasConfiguredModel(providerCfg: unknown, modelId: string): boolean {
  return copyArrayEntries(readRecordValue(providerCfg, "models")).some(
    (model) => readModelId(model) === modelId,
  );
}

export function resolveConfiguredProviderFallback(params: {
  cfg: Pick<OpenClawConfig, "models">;
  defaultProvider: string;
  defaultModel?: string;
}): ProviderModelRef | null {
  const configuredProviders = params.cfg.models?.providers;
  if (!configuredProviders || typeof configuredProviders !== "object") {
    return null;
  }
  const defaultProviderConfig = readRecordValue(configuredProviders, params.defaultProvider);
  const defaultModel = params.defaultModel?.trim();
  const defaultProviderHasDefaultModel =
    !!defaultProviderConfig &&
    !!defaultModel &&
    hasConfiguredModel(defaultProviderConfig, defaultModel);
  if (defaultProviderConfig && (!defaultModel || defaultProviderHasDefaultModel)) {
    return null;
  }
  for (const [provider, providerCfg] of copyRecordEntries(configuredProviders)) {
    const model = firstConfiguredModelId(providerCfg);
    if (model) {
      return { provider, model };
    }
  }
  return null;
}
