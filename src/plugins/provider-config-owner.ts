import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

function copyProviderEntries(value: unknown): Array<[string, ModelProviderConfig]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, ModelProviderConfig]> = [];
  for (const key of keys) {
    const provider = readRecordValue(value, key);
    if (isRecord(provider)) {
      entries.push([key, provider as ModelProviderConfig]);
    }
  }
  return entries;
}

export function resolveConfiguredProviderConfig(params: {
  provider: string;
  config?: OpenClawConfig;
}): ModelProviderConfig | undefined {
  const providers = readRecordValue(readRecordValue(params.config, "models"), "providers");
  if (!isRecord(providers)) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }
  const exactProvider = readRecordValue(providers, params.provider);
  if (isRecord(exactProvider)) {
    return exactProvider as ModelProviderConfig;
  }
  return copyProviderEntries(providers).find(
    ([candidateId]) => normalizeProviderId(candidateId) === normalizedProvider,
  )?.[1];
}

export function resolveProviderConfigApiOwnerHint(params: {
  provider: string;
  config?: OpenClawConfig;
}): string | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const providerConfig = resolveConfiguredProviderConfig(params);
  const api = normalizeProviderId(
    typeof readRecordValue(providerConfig, "api") === "string"
      ? String(readRecordValue(providerConfig, "api"))
      : "",
  );
  if (!api || api === normalizedProvider) {
    return undefined;
  }
  return api;
}
