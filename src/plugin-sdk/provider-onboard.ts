// Keep provider onboarding helpers dependency-light so bundled provider plugins
// do not pull heavyweight runtime graphs at activation time.

import { ensureStaticModelAllowlistEntry } from "../agents/model-allowlist-entry.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { findNormalizedProviderKey } from "../agents/provider-id.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type { OpenClawConfig, ModelApi, ModelDefinitionConfig, ModelProviderConfig };
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";

export type AgentModelAliasEntry =
  | string
  | {
      modelRef: string;
      alias?: string;
    };

const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";

export type ProviderOnboardPresetAppliers<TArgs extends unknown[]> = {
  applyProviderConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
  applyConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ReadValueResult = {
  value: unknown;
  complete: boolean;
};

function readRecordValueResult(record: unknown, key: string): ReadValueResult {
  if (!isRecord(record)) {
    return { value: undefined, complete: true };
  }
  try {
    return { value: record[key], complete: true };
  } catch {
    return { value: undefined, complete: false };
  }
}

function readRecordValue(record: unknown, key: string): unknown {
  return readRecordValueResult(record, key).value;
}

type RecordEntriesResult = {
  entries: Array<[string, unknown]>;
  complete: boolean;
};

function copyRecordEntriesResult(
  value: unknown,
  options?: {
    incompleteOnReadError?: boolean;
  },
): RecordEntriesResult {
  if (!isRecord(value)) {
    return { entries: [], complete: true };
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return { entries: [], complete: false };
  }
  const entries: Array<[string, unknown]> = [];
  let complete = true;
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      if (options?.incompleteOnReadError) {
        complete = false;
      }
      continue;
    }
  }
  return { entries, complete };
}

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  return copyRecordEntriesResult(value).entries;
}

function copyRecordResult(value: unknown): {
  record: Record<string, unknown>;
  complete: boolean;
} {
  const result = copyRecordEntriesResult(value, { incompleteOnReadError: true });
  return { record: Object.fromEntries(result.entries), complete: result.complete };
}

function copyRecord(value: unknown): Record<string, unknown> {
  return copyRecordResult(value).record;
}

function createMutableRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

type ArrayEntriesResult<T> = {
  entries: T[];
  complete: boolean;
  length: number;
};

function copyArrayEntriesResult<T = unknown>(value: unknown): ArrayEntriesResult<T> {
  if (!Array.isArray(value)) {
    return { entries: [], complete: true, length: 0 };
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return { entries: [], complete: false, length: 0 };
  }
  const entries: T[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      if (index in value) {
        entries.push(value[index] as T);
      }
    } catch {
      continue;
    }
  }
  return { entries, complete: entries.length === length, length };
}

function copyArrayEntries<T = unknown>(value: unknown): T[] {
  return copyArrayEntriesResult<T>(value).entries;
}

function readPrimaryStringValueResult(value: unknown): {
  value: string | undefined;
  complete: boolean;
} {
  if (typeof value === "string") {
    return { value: normalizeOptionalString(value), complete: true };
  }
  const primary = readRecordValueResult(value, "primary");
  return {
    value: normalizeOptionalString(primary.value),
    complete: primary.complete,
  };
}

function readAgentDefaults(cfg: OpenClawConfig): unknown {
  return readRecordValue(readRecordValue(cfg, "agents"), "defaults");
}

function readAgentDefaultModelsResult(cfg: OpenClawConfig): {
  models: Record<string, AgentModelEntryConfig>;
  complete: boolean;
} {
  const result = copyRecordResult(readRecordValue(readAgentDefaults(cfg), "models"));
  return {
    models: result.record as Record<string, AgentModelEntryConfig>,
    complete: result.complete,
  };
}

function readModelsConfig(cfg: OpenClawConfig): unknown {
  return readRecordValue(cfg, "models");
}

function extractAgentDefaultModelFallbacks(model: unknown): string[] | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  if (!("fallbacks" in model)) {
    return undefined;
  }
  const fallbacks = readRecordValue(model, "fallbacks");
  return Array.isArray(fallbacks)
    ? copyArrayEntries(fallbacks).map((value) => String(value))
    : undefined;
}

function hasAgentDefaultModelPrimary(cfg: OpenClawConfig): boolean {
  const result = readPrimaryStringValueResult(readRecordValue(readAgentDefaults(cfg), "model"));
  return !result.complete || result.value !== undefined;
}

function normalizeAgentModelAliasEntry(entry: AgentModelAliasEntry): {
  modelRef: string;
  alias?: string;
} {
  if (typeof entry === "string") {
    return { modelRef: entry };
  }
  return {
    modelRef: String(readRecordValue(entry, "modelRef") ?? ""),
    ...(typeof readRecordValue(entry, "alias") === "string"
      ? { alias: String(readRecordValue(entry, "alias")) }
      : undefined),
  };
}

type ProviderModelMergeState = {
  providers: Record<string, ModelProviderConfig>;
  providerMapReadable: boolean;
  existingProvider?: ModelProviderConfig;
  existingModels: ModelDefinitionConfig[];
};

function normalizeProviderModelForConfig(
  providerId: string,
  model: unknown,
): ModelDefinitionConfig | undefined {
  if (!isRecord(model)) {
    return undefined;
  }
  const modelId = readRecordValue(model, "id");
  if (typeof modelId !== "string") {
    return undefined;
  }
  const id = normalizeConfiguredProviderCatalogModelId(providerId, modelId);
  return id === modelId
    ? (model as ModelDefinitionConfig)
    : { ...(copyRecord(model) as ModelDefinitionConfig), id };
}

function normalizeProviderModelsForConfig(
  providerId: string,
  models: unknown,
): ModelDefinitionConfig[] {
  let mutated = false;
  const next: ModelDefinitionConfig[] = [];
  const seenById = new Map<string, number>();

  const copiedModels = copyArrayEntriesResult(models);
  const modelEntries = copiedModels.entries;
  if (!Array.isArray(models) || !copiedModels.complete) {
    mutated = true;
  }
  for (const model of modelEntries) {
    const normalized = normalizeProviderModelForConfig(providerId, model);
    if (!normalized) {
      mutated = true;
      continue;
    }
    if (normalized !== model) {
      mutated = true;
    }
    const existingIndex = seenById.get(normalized.id);
    if (existingIndex !== undefined) {
      mutated = true;
      next[existingIndex] = { ...normalized, ...next[existingIndex] };
      continue;
    }
    seenById.set(normalized.id, next.length);
    next.push(normalized);
  }

  return mutated ? next : (models as ModelDefinitionConfig[]);
}

function normalizeModelProvidersForConfig(
  providers: Record<string, ModelProviderConfig> | undefined,
): Record<string, ModelProviderConfig> | undefined {
  if (!providers) {
    return providers;
  }

  const nextProviders = createMutableRecord<ModelProviderConfig>();
  const copiedProviders = copyRecordEntriesResult(providers);
  if (!copiedProviders.complete) {
    return providers;
  }
  for (const [providerId, providerConfig] of copiedProviders.entries) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    const modelValue = readRecordValue(providerConfig, "models");
    if (Array.isArray(modelValue)) {
      const models = normalizeProviderModelsForConfig(providerId, modelValue);
      if (models === modelValue) {
        nextProviders[providerId] = providerConfig as ModelProviderConfig;
        continue;
      }
      nextProviders[providerId] = {
        ...(copyRecord(providerConfig) as ModelProviderConfig),
        models,
      };
      continue;
    }
    nextProviders[providerId] = providerConfig as ModelProviderConfig;
  }

  return nextProviders;
}

function resolveProviderModelMergeState(
  cfg: OpenClawConfig,
  providerId: string,
): ProviderModelMergeState {
  const providers = createMutableRecord<ModelProviderConfig>();
  const copiedProviders = copyRecordEntriesResult(
    readRecordValue(readModelsConfig(cfg), "providers"),
  );
  if (!copiedProviders.complete) {
    return { providers, providerMapReadable: false, existingModels: [] };
  }
  for (const [key, value] of copiedProviders.entries) {
    if (isRecord(value)) {
      providers[key] = value as ModelProviderConfig;
    }
  }
  const existingProviderKey = findNormalizedProviderKey(providers, providerId);
  const existingProvider =
    existingProviderKey !== undefined
      ? (readRecordValue(providers, existingProviderKey) as ModelProviderConfig | undefined)
      : undefined;
  const existingModelValue = readRecordValue(existingProvider, "models");
  const existingModels: ModelDefinitionConfig[] = Array.isArray(existingModelValue)
    ? normalizeProviderModelsForConfig(providerId, existingModelValue)
    : [];
  if (existingProviderKey && existingProviderKey !== providerId) {
    delete providers[existingProviderKey];
  }
  return {
    providers,
    providerMapReadable: true,
    existingProvider: existingProvider
      ? { ...existingProvider, models: existingModels }
      : existingProvider,
    existingModels,
  };
}

function buildProviderConfig(params: {
  existingProvider: ModelProviderConfig | undefined;
  api: ModelApi;
  baseUrl: string;
  mergedModels: ModelDefinitionConfig[];
  fallbackModels: ModelDefinitionConfig[];
}): ModelProviderConfig {
  const existingProviderRest = copyRecord(params.existingProvider) as ModelProviderConfig & {
    apiKey?: unknown;
  };
  const existingApiKey = existingProviderRest.apiKey;
  delete existingProviderRest.apiKey;
  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  return {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: params.api,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: params.mergedModels.length > 0 ? params.mergedModels : params.fallbackModels,
  };
}

function applyProviderConfigWithMergedModels(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    providerState: ProviderModelMergeState;
    api: ModelApi;
    baseUrl: string;
    mergedModels: ModelDefinitionConfig[];
    fallbackModels: ModelDefinitionConfig[];
  },
): OpenClawConfig {
  if (!params.providerState.providerMapReadable) {
    return cfg;
  }
  const mergedModels = normalizeProviderModelsForConfig(params.providerId, params.mergedModels);
  const fallbackModels = normalizeProviderModelsForConfig(params.providerId, params.fallbackModels);
  params.providerState.providers[params.providerId] = buildProviderConfig({
    existingProvider: params.providerState.existingProvider,
    api: params.api,
    baseUrl: params.baseUrl,
    mergedModels,
    fallbackModels,
  });
  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: params.agentModels,
    providers: params.providerState.providers,
  });
}

function createProviderPresetAppliers<
  TArgs extends unknown[],
  TParams extends {
    primaryModelRef?: string;
  },
>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) => Omit<TParams, "primaryModelRef"> | null | undefined;
  applyPreset: (cfg: OpenClawConfig, preset: TParams) => OpenClawConfig;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return {
    applyProviderConfig(cfg, ...args) {
      const resolved = params.resolveParams(cfg, ...args);
      return resolved ? params.applyPreset(cfg, resolved as TParams) : cfg;
    },
    applyConfig(cfg, ...args) {
      const resolved = params.resolveParams(cfg, ...args);
      if (!resolved) {
        return cfg;
      }
      return params.applyPreset(cfg, {
        ...(resolved as TParams),
        primaryModelRef: params.primaryModelRef,
      });
    },
  };
}

export function withAgentModelAliases(
  existing: Record<string, AgentModelEntryConfig> | undefined,
  aliases: readonly AgentModelAliasEntry[],
): Record<string, AgentModelEntryConfig> {
  const next = normalizeAgentModelMapForConfig(
    copyRecord(existing) as Record<string, AgentModelEntryConfig>,
  );
  for (const entry of copyArrayEntries<AgentModelAliasEntry>(aliases)) {
    const normalized = normalizeAgentModelAliasEntry(entry);
    if (!normalized.modelRef) {
      continue;
    }
    const modelRef = normalizeAgentModelRefForConfig(normalized.modelRef);
    next[modelRef] = {
      ...next[modelRef],
      ...(normalized.alias ? { alias: next[modelRef]?.alias ?? normalized.alias } : {}),
    };
  }
  return next;
}

export function applyOnboardAuthAgentModelsAndProviders(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providers: Record<string, ModelProviderConfig>;
  },
): OpenClawConfig {
  const cfgCopy = copyRecordResult(cfg);
  const agentsValue = readRecordValue(cfg, "agents");
  const agentsCopy = copyRecordResult(agentsValue);
  const defaultsValue = readRecordValue(agentsValue, "defaults");
  const defaultsCopy = copyRecordResult(defaultsValue);
  const modelsValue = readModelsConfig(cfg);
  const modelsCopy = copyRecordResult(modelsValue);
  const defaultModelsValue = readRecordValue(defaultsValue, "models");
  const defaultModelsCopy = copyRecordEntriesResult(defaultModelsValue, {
    incompleteOnReadError: true,
  });
  if (
    !cfgCopy.complete ||
    (isRecord(agentsValue) && !agentsCopy.complete) ||
    (isRecord(defaultsValue) && !defaultsCopy.complete) ||
    (isRecord(defaultModelsValue) && !defaultModelsCopy.complete) ||
    (isRecord(modelsValue) && !modelsCopy.complete)
  ) {
    return cfg;
  }
  const mode = readRecordValue(modelsValue, "mode");
  const mergedAgentModels = normalizeAgentModelMapForConfig(
    Object.fromEntries([
      ...defaultModelsCopy.entries,
      ...copyRecordEntries(params.agentModels),
    ]) as Record<string, AgentModelEntryConfig>,
  );
  return {
    ...(cfgCopy.record as OpenClawConfig),
    agents: {
      ...agentsCopy.record,
      defaults: {
        ...defaultsCopy.record,
        models: mergedAgentModels,
      },
    },
    models: {
      mode: mode ?? "merge",
      providers: params.providers,
    },
  };
}

export function applyAgentDefaultModelPrimary(
  cfg: OpenClawConfig,
  primary: string,
): OpenClawConfig {
  const cfgCopy = copyRecordResult(cfg);
  const agentsValue = readRecordValue(cfg, "agents");
  const agentsCopy = copyRecordResult(agentsValue);
  const defaults = readAgentDefaults(cfg);
  const defaultsCopy = copyRecordResult(defaults);
  if (
    !cfgCopy.complete ||
    (isRecord(agentsValue) && !agentsCopy.complete) ||
    (isRecord(defaults) && !defaultsCopy.complete)
  ) {
    return cfg;
  }
  const existingFallbacks = extractAgentDefaultModelFallbacks(readRecordValue(defaults, "model"));
  const normalizedFallbacks = existingFallbacks?.map((fallback) =>
    normalizeAgentModelRefForConfig(fallback),
  );
  const defaultModelsValue = readRecordValue(defaults, "models");
  const defaultModelsCopy = copyRecordResult(defaultModelsValue);
  const normalizedModels =
    defaultModelsValue === undefined
      ? undefined
      : defaultModelsCopy.complete
        ? normalizeAgentModelMapForConfig(
            defaultModelsCopy.record as Record<string, AgentModelEntryConfig>,
          )
        : (defaultModelsValue as Record<string, AgentModelEntryConfig>);
  const models = readModelsConfig(cfg);
  const modelsCopy = copyRecordResult(models);
  const normalizedProviders = modelsCopy.complete
    ? normalizeModelProvidersForConfig(
        readRecordValue(models, "providers") as Record<string, ModelProviderConfig> | undefined,
      )
    : undefined;
  return {
    ...(cfgCopy.record as OpenClawConfig),
    agents: {
      ...agentsCopy.record,
      defaults: {
        ...defaultsCopy.record,
        model: {
          ...(normalizedFallbacks ? { fallbacks: normalizedFallbacks } : undefined),
          primary: normalizeAgentModelRefForConfig(primary),
        },
        ...(normalizedModels !== undefined ? { models: normalizedModels } : undefined),
      },
    },
    ...(normalizedProviders !== undefined
      ? {
          models: {
            ...modelsCopy.record,
            providers: normalizedProviders,
          },
        }
      : isRecord(models)
        ? { models: models as OpenClawConfig["models"] }
        : undefined),
  };
}

export function applyOpencodeZenModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const currentResult = readPrimaryStringValueResult(
    readRecordValue(readAgentDefaults(cfg), "model"),
  );
  if (!currentResult.complete) {
    return { next: cfg, changed: false };
  }
  const current = currentResult.value;
  const normalizedCurrent =
    current && LEGACY_OPENCODE_ZEN_DEFAULT_MODELS.has(current)
      ? OPENCODE_ZEN_DEFAULT_MODEL
      : current;
  if (normalizedCurrent === OPENCODE_ZEN_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, OPENCODE_ZEN_DEFAULT_MODEL),
    changed: true,
  };
}

export function applyProviderConfigWithDefaultModels(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
  },
): OpenClawConfig {
  const providerState = resolveProviderModelMergeState(cfg, params.providerId);
  const defaultModels = normalizeProviderModelsForConfig(params.providerId, params.defaultModels);
  const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
  const hasDefaultModel = defaultModelId
    ? providerState.existingModels.some((model) => model.id === defaultModelId)
    : true;
  const mergedModels =
    providerState.existingModels.length > 0
      ? hasDefaultModel || defaultModels.length === 0
        ? providerState.existingModels
        : [...providerState.existingModels, ...defaultModels]
      : defaultModels;
  return applyProviderConfigWithMergedModels(cfg, {
    agentModels: params.agentModels,
    providerId: params.providerId,
    providerState,
    api: params.api,
    baseUrl: params.baseUrl,
    mergedModels,
    fallbackModels: defaultModels,
  });
}

export function applyProviderConfigWithDefaultModel(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
  },
): OpenClawConfig {
  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: params.agentModels,
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModels: [params.defaultModel],
    defaultModelId:
      params.defaultModelId ??
      (typeof readRecordValue(params.defaultModel, "id") === "string"
        ? String(readRecordValue(params.defaultModel, "id"))
        : undefined),
  });
}

export function applyProviderConfigWithDefaultModelPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const agentModels = readAgentDefaultModelsResult(cfg);
  if (!agentModels.complete) {
    return cfg;
  }
  const next = applyProviderConfigWithDefaultModel(cfg, {
    agentModels: withAgentModelAliases(agentModels.models, params.aliases ?? []),
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModel: params.defaultModel,
    defaultModelId: params.defaultModelId,
  });
  if (next === cfg) {
    return cfg;
  }
  return params.primaryModelRef
    ? hasAgentDefaultModelPrimary(cfg)
      ? next
      : applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createDefaultModelPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithDefaultModelPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    resolveParams: params.resolveParams,
    applyPreset: applyProviderConfigWithDefaultModelPreset,
    primaryModelRef: params.primaryModelRef,
  });
}

export function applyProviderConfigWithDefaultModelsPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const agentModels = readAgentDefaultModelsResult(cfg);
  if (!agentModels.complete) {
    return cfg;
  }
  const next = applyProviderConfigWithDefaultModels(cfg, {
    agentModels: withAgentModelAliases(agentModels.models, params.aliases ?? []),
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModels: params.defaultModels,
    defaultModelId: params.defaultModelId,
  });
  if (next === cfg) {
    return cfg;
  }
  return params.primaryModelRef
    ? hasAgentDefaultModelPrimary(cfg)
      ? next
      : applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createDefaultModelsPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithDefaultModelsPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    resolveParams: params.resolveParams,
    applyPreset: applyProviderConfigWithDefaultModelsPreset,
    primaryModelRef: params.primaryModelRef,
  });
}

export function applyProviderConfigWithModelCatalog(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
  },
): OpenClawConfig {
  const providerState = resolveProviderModelMergeState(cfg, params.providerId);
  const catalogModels = normalizeProviderModelsForConfig(params.providerId, params.catalogModels);
  const mergedModels =
    providerState.existingModels.length > 0
      ? [
          ...providerState.existingModels,
          ...catalogModels.filter(
            (model) => !providerState.existingModels.some((existing) => existing.id === model.id),
          ),
        ]
      : catalogModels;
  return applyProviderConfigWithMergedModels(cfg, {
    agentModels: params.agentModels,
    providerId: params.providerId,
    providerState,
    api: params.api,
    baseUrl: params.baseUrl,
    mergedModels,
    fallbackModels: catalogModels,
  });
}

export function applyProviderConfigWithModelCatalogPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const agentModels = readAgentDefaultModelsResult(cfg);
  if (!agentModels.complete) {
    return cfg;
  }
  const next = applyProviderConfigWithModelCatalog(cfg, {
    agentModels: withAgentModelAliases(agentModels.models, params.aliases ?? []),
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    catalogModels: params.catalogModels,
  });
  if (next === cfg) {
    return cfg;
  }
  return params.primaryModelRef
    ? hasAgentDefaultModelPrimary(cfg)
      ? next
      : applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithModelCatalogPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    resolveParams: params.resolveParams,
    applyPreset: applyProviderConfigWithModelCatalogPreset,
    primaryModelRef: params.primaryModelRef,
  });
}

export function ensureModelAllowlistEntry(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  defaultProvider?: string;
}): OpenClawConfig {
  return ensureStaticModelAllowlistEntry(params);
}
