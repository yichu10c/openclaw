import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import { resolveConfiguredProviderConfig } from "./provider-config-owner.js";

type EmbeddingProviderCapabilityKey = "embeddingProviders" | "memoryEmbeddingProviders";
type RegisteredAdapterEntry<TAdapter> = {
  adapter: TAdapter;
};
function readStringProperty(providerConfig: ModelProviderConfig | undefined, key: string): string {
  if (!providerConfig) {
    return "";
  }
  try {
    const value = (providerConfig as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function resolveMissingApiProviderId(
  resolve: ((providerConfig: ModelProviderConfig) => string | undefined) | undefined,
  providerConfig: ModelProviderConfig,
): string | undefined {
  try {
    return resolve?.(providerConfig);
  } catch {
    return undefined;
  }
}

export function readConfiguredProviderApiId(params: {
  providerId: string;
  cfg?: OpenClawConfig;
  resolveApiProviderId?: (normalizedApiId: string) => string | undefined;
  resolveMissingApiProviderId?: (providerConfig: ModelProviderConfig) => string | undefined;
}): string | undefined {
  const providerConfig = resolveConfiguredProviderConfig({
    provider: params.providerId,
    config: params.cfg,
  });
  if (!providerConfig) {
    return undefined;
  }
  const normalized = normalizeProviderId(params.providerId);
  const api = readStringProperty(providerConfig, "api").trim();
  const resolvedProviderId = api
    ? (params.resolveApiProviderId?.(normalizeProviderId(api)) ?? normalizeProviderId(api))
    : resolveMissingApiProviderId(params.resolveMissingApiProviderId, providerConfig);
  return resolvedProviderId && resolvedProviderId !== normalized ? resolvedProviderId : undefined;
}

export function resolveRuntimeEmbeddingProviderLookupIds(params: {
  id: string;
  cfg?: OpenClawConfig;
  resolveConfiguredProviderId: (id: string, cfg?: OpenClawConfig) => string | undefined;
}): string[] {
  const ids = [params.id];
  const configuredProviderId = params.resolveConfiguredProviderId(params.id, params.cfg);
  if (
    configuredProviderId &&
    !ids.some((candidate) => normalizeProviderId(candidate) === configuredProviderId)
  ) {
    ids.push(configuredProviderId);
  }
  return ids;
}

export function listRuntimeEmbeddingProviderAdapters<TAdapter extends { id: string }>(params: {
  key: EmbeddingProviderCapabilityKey;
  cfg?: OpenClawConfig;
  registered: TAdapter[];
}): TAdapter[] {
  const merged = new Map(params.registered.map((adapter) => [adapter.id, adapter]));
  const capabilityAdapters = resolvePluginCapabilityProviders({
    key: params.key,
    cfg: params.cfg,
  }) as unknown as TAdapter[];
  for (const adapter of capabilityAdapters) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

export function getRuntimeEmbeddingProviderAdapter<TAdapter extends { id: string }>(params: {
  key: EmbeddingProviderCapabilityKey;
  cfg?: OpenClawConfig;
  lookupIds: string[];
  getRegisteredProvider: (id: string) => RegisteredAdapterEntry<TAdapter> | undefined;
}): TAdapter | undefined {
  for (const candidateId of params.lookupIds) {
    const registered = params.getRegisteredProvider(candidateId);
    if (registered) {
      return registered.adapter;
    }
  }
  for (const candidateId of params.lookupIds) {
    const provider = resolvePluginCapabilityProvider({
      key: params.key,
      providerId: candidateId,
      cfg: params.cfg,
    }) as TAdapter | undefined;
    if (provider) {
      return provider;
    }
  }
  return undefined;
}
