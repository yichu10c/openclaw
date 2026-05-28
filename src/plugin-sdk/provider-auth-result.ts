import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function copyArrayEntries<T>(value: readonly T[]): T[] | undefined {
  let length: number;
  try {
    length = value.length;
  } catch {
    return undefined;
  }

  const entries: T[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      if (index in value) {
        entries.push(value[index]);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function copyObjectEntriesWithStatus(
  value: unknown,
): { entries: Array<[string, unknown]>; skipped: boolean } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return undefined;
  }

  const entries: Array<[string, unknown]> = [];
  let skipped = false;
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      skipped = true;
    }
  }
  return { entries, skipped };
}

function copyObjectEntries(value: unknown): Array<[string, unknown]> | undefined {
  return copyObjectEntriesWithStatus(value)?.entries;
}

function copyRecord(value: unknown): Record<string, unknown> | undefined {
  const entries = copyObjectEntries(value);
  return entries ? Object.fromEntries(entries) : undefined;
}

function withConfigPatchModels(
  next: Partial<OpenClawConfig>,
  patchRecord: Record<string, unknown>,
  models: Record<string, unknown>,
): Partial<OpenClawConfig> {
  return {
    ...(copyRecord(next) ?? patchRecord),
    models,
  };
}

function normalizeAgentModelConfigForAuthResult(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  const copied = copyRecord(value);
  if (!copied) {
    return value;
  }

  let mutated = false;
  const next: Record<string, unknown> = copied;
  if (typeof next.primary === "string") {
    const primary = normalizeAgentModelRefForConfig(next.primary);
    if (primary !== next.primary) {
      next.primary = primary;
      mutated = true;
    }
  }
  if (Array.isArray(next.fallbacks)) {
    const originalFallbacks = next.fallbacks;
    const fallbacks = copyArrayEntries(originalFallbacks);
    if (fallbacks) {
      for (let index = 0; index < fallbacks.length; index += 1) {
        const fallback = fallbacks[index];
        if (typeof fallback === "string") {
          fallbacks[index] = normalizeAgentModelRefForConfig(fallback);
        }
      }
      next.fallbacks = fallbacks;
      mutated = true;
    }
  }
  return mutated ? next : value;
}

function normalizeProviderConfigModelIdsForAuthResult(
  provider: string,
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  const models = providerConfig.models;
  if (!Array.isArray(models) || models.length === 0) {
    return providerConfig;
  }

  let mutated = false;
  const copiedModels = copyArrayEntries(models);
  if (!copiedModels) {
    return providerConfig;
  }
  const nextModels = copiedModels.map((model) => {
    const id = normalizeConfiguredProviderCatalogModelId(provider, model.id);
    if (id === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id });
  });
  const nextProviderConfig = copyRecord(providerConfig) as ModelProviderConfig | undefined;
  if (!nextProviderConfig) {
    return providerConfig;
  }
  nextProviderConfig.models = nextModels;
  return mutated || nextModels !== models ? nextProviderConfig : providerConfig;
}

function normalizeProviderAuthConfigPatchModelRefs(
  patch: Partial<OpenClawConfig>,
): Partial<OpenClawConfig> {
  const patchRecord = copyRecord(patch);
  if (!patchRecord) {
    return patch;
  }

  let next: Partial<OpenClawConfig> = patch;
  const agents = readRecordValue(patchRecord, "agents");
  const defaults = isRecord(agents) ? readRecordValue(agents, "defaults") : undefined;
  if (isRecord(defaults)) {
    let nextDefaults = defaults;
    const defaultModel = readRecordValue(defaults, "model");
    if (defaultModel !== undefined) {
      const model = normalizeAgentModelConfigForAuthResult(defaultModel);
      if (model !== defaultModel) {
        nextDefaults = { ...nextDefaults, model };
      }
    }
    const defaultModels = readRecordValue(defaults, "models");
    if (isRecord(defaultModels)) {
      try {
        const models = normalizeAgentModelMapForConfig(defaultModels);
        if (models !== defaultModels) {
          nextDefaults = { ...nextDefaults, models };
        }
      } catch {
        // Ignore unreadable plugin-provided model maps; auth should still return.
      }
    }
    if (nextDefaults !== defaults) {
      next = {
        ...patchRecord,
        agents: {
          ...(isRecord(agents) ? agents : {}),
          defaults: nextDefaults,
        },
      };
    }
  }

  const rawModels = readRecordValue(patchRecord, "models");
  const models = isRecord(rawModels) ? copyRecord(rawModels) : undefined;
  if (isRecord(rawModels) && !models) {
    return withConfigPatchModels(next, patchRecord, {});
  }
  const providers = models ? readRecordValue(models, "providers") : undefined;
  if (!isRecord(providers)) {
    return models ? withConfigPatchModels(next, patchRecord, models) : next;
  }

  const providerEntryCopy = copyObjectEntriesWithStatus(providers);
  if (!providerEntryCopy) {
    const nextModels = { ...models };
    delete nextModels.providers;
    return withConfigPatchModels(next, patchRecord, nextModels);
  }
  const providerEntries = providerEntryCopy.entries;

  let mutated = providerEntryCopy.skipped;
  const nextProviders = Object.fromEntries(providerEntries) as Record<string, ModelProviderConfig>;
  for (const [provider, providerConfig] of providerEntries) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    const normalized = normalizeProviderConfigModelIdsForAuthResult(
      provider,
      providerConfig as ModelProviderConfig,
    );
    if (normalized === providerConfig) {
      continue;
    }
    nextProviders[provider] = normalized;
    mutated = true;
  }

  return mutated
    ? {
        ...(copyRecord(next) ?? patchRecord),
        models: {
          ...models,
          providers: nextProviders,
        },
      }
    : next;
}

/** Build the standard auth result payload for OAuth-style provider login flows. */
export function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  displayName?: string | null;
  profileName?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult {
  const email = params.email ?? undefined;
  const displayName = params.displayName ?? undefined;
  const defaultModel = normalizeAgentModelRefForConfig(params.defaultModel);
  const profileId = buildAuthProfileId({
    providerId: params.providerId,
    profilePrefix: params.profilePrefix,
    profileName: params.profileName ?? email,
  });

  const credential: AuthProfileCredential = {
    type: "oauth",
    provider: params.providerId,
    access: params.access,
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(Number.isFinite(params.expires) ? { expires: params.expires as number } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...params.credentialExtra,
  } as AuthProfileCredential;

  return {
    profiles: [{ profileId, credential }],
    configPatch: normalizeProviderAuthConfigPatchModelRefs(
      params.configPatch ??
        ({
          agents: {
            defaults: {
              models: {
                [defaultModel]: {},
              },
            },
          },
        } as Partial<OpenClawConfig>),
    ),
    defaultModel,
    notes: params.notes,
  };
}
