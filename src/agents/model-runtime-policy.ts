import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "./agent-scope.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelRuntimePolicySource = "model" | "provider";

export type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
  matchedProvider?: string;
};

type ModelEntryMatchKind = "none" | "exact" | "provider-wildcard";

type AgentModelRuntimePolicyMatch = {
  provider: string;
  policy: AgentRuntimePolicyConfig;
};

type AgentModelRuntimePolicyResolution = ResolvedModelRuntimePolicy & {
  ambiguous?: true;
};

const MAX_MODEL_RUNTIME_POLICY_LIST_ENTRIES = 10_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyArrayEntries(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const safeLength = Math.min(Math.max(0, length), MAX_MODEL_RUNTIME_POLICY_LIST_ENTRIES);
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

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
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
      // Skip unreadable model runtime policy entries; readable config still applies.
    }
  }
  return entries;
}

function hasRuntimePolicy(value: AgentRuntimePolicyConfig | undefined): boolean {
  const id = readRecordValue(value, "id");
  return typeof id === "string" && id.trim().length > 0;
}

function resolveProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string | undefined,
): ModelProviderConfig | undefined {
  const providers = readRecordValue(readRecordValue(config, "models"), "providers");
  if (!isRecord(providers) || !provider?.trim()) {
    return undefined;
  }
  const direct = readRecordValue(providers, provider);
  if (isRecord(direct)) {
    return direct as ModelProviderConfig;
  }
  const normalizedProvider = normalizeProviderId(provider);
  for (const [candidateProvider, providerConfig] of copyRecordEntries(providers)) {
    if (normalizeProviderId(candidateProvider) === normalizedProvider) {
      return isRecord(providerConfig) ? (providerConfig as ModelProviderConfig) : undefined;
    }
  }
  return undefined;
}

function normalizeModelIdForProvider(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  const modelProvider = normalizeProviderId(trimmed.slice(0, slash));
  const expectedProvider = normalizeProviderId(provider ?? "");
  if (expectedProvider && modelProvider !== expectedProvider) {
    return undefined;
  }
  return trimmed.slice(slash + 1).trim() || undefined;
}

function parseProviderModelKey(key: string): { provider: string; modelId: string } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(key.slice(0, slash));
  const modelId = key.slice(slash + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

function providerMatchesCaller(provider: string, callerProvider: string): boolean {
  return !callerProvider || provider === callerProvider;
}

function resolvePolicyMatch(
  matches: AgentModelRuntimePolicyMatch[],
  callerProvider: string,
): AgentModelRuntimePolicyResolution {
  const [first] = matches;
  if (!first) {
    return {};
  }
  if (!callerProvider && matches.some((match) => match.provider !== first.provider)) {
    return { ambiguous: true };
  }
  return {
    policy: first.policy,
    source: "model",
    matchedProvider: first.provider || callerProvider,
  };
}

function modelEntryMatches(params: {
  entry: unknown;
  provider: string | undefined;
  modelId: string;
}): boolean {
  return modelEntryMatchKind(params) === "exact";
}

function modelEntryMatchKind(params: {
  entry: unknown;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  const id = readRecordValue(params.entry, "id");
  if (typeof id !== "string") {
    return "none";
  }
  const entryId = id.trim();
  if (entryId === params.modelId) {
    return "exact";
  }
  const parsed = parseProviderModelKey(entryId);
  if (!parsed) {
    return "none";
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  if (!providerMatchesCaller(parsed.provider, callerProvider)) {
    return "none";
  }
  if (parsed.modelId === params.modelId) {
    return "exact";
  }
  if (parsed.modelId === "*") {
    return "provider-wildcard";
  }
  return "none";
}

function modelKeyMatchKind(params: {
  key: string;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  return modelEntryMatchKind({
    entry: { id: params.key },
    provider: params.provider,
    modelId: params.modelId,
  });
}

function modelKeyIsProviderWildcard(params: {
  key: string;
  provider: string | undefined;
}): boolean {
  const parsed = parseProviderModelKey(params.key);
  if (!parsed) {
    return false;
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  return parsed.modelId === "*" && providerMatchesCaller(parsed.provider, callerProvider);
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  matchKind: Exclude<ModelEntryMatchKind, "none">;
}): AgentModelRuntimePolicyResolution {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const agentEntry = listAgentEntries(params.config).find(
    (entry) => normalizeAgentId(entry.id) === sessionAgentId,
  );
  const modelMaps = [
    readRecordValue(agentEntry, "models"),
    readRecordValue(
      readRecordValue(readRecordValue(params.config, "agents"), "defaults"),
      "models",
    ),
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  for (const models of modelMaps) {
    const scopeMatches: AgentModelRuntimePolicyMatch[] = [];
    for (const [key, entry] of copyRecordEntries(models)) {
      const matches = modelId
        ? modelKeyMatchKind({ key, provider: params.provider, modelId }) === params.matchKind
        : modelKeyIsProviderWildcard({ key, provider: params.provider });
      const policy = readRecordValue(entry, "agentRuntime") as AgentRuntimePolicyConfig | undefined;
      if (!matches || !policy || !hasRuntimePolicy(policy)) {
        continue;
      }
      scopeMatches.push({ provider: parseProviderModelKey(key)?.provider ?? "", policy });
    }
    const resolved = resolvePolicyMatch(scopeMatches, callerProvider);
    if (resolved.policy || resolved.ambiguous) {
      return resolved;
    }
  }
  return {};
}

function resolveModelConfig(params: {
  providerConfig?: ModelProviderConfig;
  provider?: string;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  const models = copyArrayEntries(readRecordValue(params.providerConfig, "models"));
  if (!modelId || !models) {
    return undefined;
  }
  const model = models.find((entry) =>
    isRecord(entry) ? modelEntryMatches({ entry, provider: params.provider, modelId }) : false,
  );
  return isRecord(model) ? (model as ModelDefinitionConfig) : undefined;
}

export function resolveModelRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "openclaw" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model" };
    }
  }

  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({ ...params, matchKind: "exact" });
  if (agentModelPolicy.ambiguous) {
    return {};
  }
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = resolveProviderConfig(params.config, params.provider);
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: params.provider,
    modelId: params.modelId,
  });
  const modelPolicy = readRecordValue(modelConfig, "agentRuntime") as
    | AgentRuntimePolicyConfig
    | undefined;
  if (hasRuntimePolicy(modelPolicy)) {
    return { policy: modelPolicy, source: "model" };
  }
  const agentWildcardModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    matchKind: "provider-wildcard",
  });
  if (agentWildcardModelPolicy.policy) {
    return agentWildcardModelPolicy;
  }
  const providerPolicy = readRecordValue(providerConfig, "agentRuntime") as
    | AgentRuntimePolicyConfig
    | undefined;
  if (hasRuntimePolicy(providerPolicy)) {
    return { policy: providerPolicy, source: "provider" };
  }
  return {};
}
