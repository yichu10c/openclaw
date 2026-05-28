import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { OPENCLAW_AGENT_RUNTIME_ID, isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { normalizeProviderId } from "./provider-id.js";

function normalizeConfiguredRuntimeId(value: unknown): string | undefined {
  return normalizeOptionalAgentRuntimeId(value);
}

function isSelectablePluginRuntime(runtime: string | undefined): runtime is string {
  return (
    !!runtime &&
    !isDefaultAgentRuntimeId(runtime) &&
    normalizeOptionalAgentRuntimeId(runtime) !== OPENCLAW_AGENT_RUNTIME_ID
  );
}

const MAX_AGENT_HARNESS_CONFIG_LIST_ENTRIES = 10_000;

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
  const safeLength = Math.min(Math.max(0, length), MAX_AGENT_HARNESS_CONFIG_LIST_ENTRIES);
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

function copyRecordKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function copyRecordValues(value: unknown): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const values: unknown[] = [];
  for (const key of copyRecordKeys(value)) {
    try {
      values.push(value[key]);
    } catch {
      // Ignore unreadable config entries; other readable model runtime config still applies.
    }
  }
  return values;
}

function listAgentModelRefs(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  const primary = readRecordValue(value, "primary");
  if (typeof primary === "string") {
    refs.push(primary);
  }
  for (const fallback of copyArrayEntries(readRecordValue(value, "fallbacks")) ?? []) {
    if (typeof fallback === "string") {
      refs.push(fallback);
    }
  }
  return refs;
}

function pushAgentModelRefs(refs: string[], value: unknown): void {
  for (const ref of listAgentModelRefs(value)) {
    refs.push(ref);
  }
}

function parseConfiguredModelRef(
  value: unknown,
): { provider: string; modelId: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    modelId: trimmed.slice(slash + 1).trim(),
  };
}

function resolveConfiguredModelHarnessRuntime(params: {
  config: OpenClawConfig;
  includeImplicitRuntimePreferences: boolean;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const parsed = parseConfiguredModelRef(params.modelRef);
  if (!parsed) {
    return undefined;
  }
  const policy = resolveAgentHarnessPolicy({
    config: params.config,
    provider: parsed.provider,
    modelId: parsed.modelId,
    agentId: params.agentId,
  });
  if (!params.includeImplicitRuntimePreferences && policy.runtimeSource === "implicit") {
    return undefined;
  }
  const runtime = normalizeConfiguredRuntimeId(policy.runtime);
  return isSelectablePluginRuntime(runtime) ? runtime : undefined;
}

function pushConfiguredModelRuntimeIds(config: OpenClawConfig, runtimes: Set<string>): void {
  for (const providerConfig of copyRecordValues(
    readRecordValue(readRecordValue(config, "models"), "providers"),
  )) {
    const providerRuntime = normalizeConfiguredRuntimeId(
      readRecordValue(readRecordValue(providerConfig, "agentRuntime"), "id"),
    );
    if (isSelectablePluginRuntime(providerRuntime)) {
      runtimes.add(providerRuntime);
    }
    for (const modelConfig of copyArrayEntries(readRecordValue(providerConfig, "models")) ?? []) {
      const modelRuntime = normalizeConfiguredRuntimeId(
        readRecordValue(readRecordValue(modelConfig, "agentRuntime"), "id"),
      );
      if (isSelectablePluginRuntime(modelRuntime)) {
        runtimes.add(modelRuntime);
      }
    }
  }
  const pushModelMapRuntimeIds = (models: unknown) => {
    if (!isRecord(models)) {
      return;
    }
    for (const entry of copyRecordValues(models)) {
      if (!isRecord(entry)) {
        continue;
      }
      const runtime = normalizeConfiguredRuntimeId(
        readRecordValue(readRecordValue(entry, "agentRuntime"), "id"),
      );
      if (isSelectablePluginRuntime(runtime)) {
        runtimes.add(runtime);
      }
    }
  };
  const agentsConfig = readRecordValue(config, "agents");
  const defaults = readRecordValue(agentsConfig, "defaults");
  pushModelMapRuntimeIds(readRecordValue(defaults, "models"));
  const agents = copyArrayEntries(readRecordValue(agentsConfig, "list")) ?? [];
  for (const agent of agents) {
    pushModelMapRuntimeIds(isRecord(agent) ? readRecordValue(agent, "models") : undefined);
  }
}

function pushConfiguredAgentModelRuntimeIds(
  config: OpenClawConfig,
  runtimes: Set<string>,
  includeImplicitRuntimePreferences: boolean,
): void {
  const pushModelRefs = (modelRefs: string[], agentId?: string) => {
    for (const modelRef of modelRefs) {
      const runtime = resolveConfiguredModelHarnessRuntime({
        config,
        includeImplicitRuntimePreferences,
        modelRef,
        agentId,
      });
      if (runtime) {
        runtimes.add(runtime);
      }
    }
  };
  const pushModelMapRefs = (models: unknown, agentId?: string) => {
    if (!isRecord(models)) {
      return;
    }
    pushModelRefs(copyRecordKeys(models), agentId);
  };

  const agentsConfig = readRecordValue(config, "agents");
  const defaults = readRecordValue(agentsConfig, "defaults");
  const defaultsModel = readRecordValue(defaults, "model");
  const defaultsModelRefs: string[] = [];
  pushAgentModelRefs(defaultsModelRefs, defaultsModel);
  pushModelRefs(defaultsModelRefs);
  pushModelMapRefs(readRecordValue(defaults, "models"));

  const agents = copyArrayEntries(readRecordValue(agentsConfig, "list"));
  if (!agents) {
    return;
  }
  for (const agent of agents) {
    if (!isRecord(agent)) {
      continue;
    }
    const id = readRecordValue(agent, "id");
    const agentId = typeof id === "string" ? id : undefined;
    const selectedModelRefs: string[] = [];
    pushAgentModelRefs(selectedModelRefs, readRecordValue(agent, "model") ?? defaultsModel);
    pushModelRefs(selectedModelRefs, agentId);
    pushModelMapRefs(readRecordValue(agent, "models"), agentId);
  }
}

export type ConfiguredAgentHarnessRuntimeOptions = {
  includeImplicitRuntimePreferences?: boolean;
};

export function collectConfiguredAgentHarnessRuntimes(
  config: OpenClawConfig,
  options: ConfiguredAgentHarnessRuntimeOptions = {},
): string[] {
  const runtimes = new Set<string>();
  const includeImplicitRuntimePreferences = options.includeImplicitRuntimePreferences ?? true;

  pushConfiguredModelRuntimeIds(config, runtimes);
  pushConfiguredAgentModelRuntimeIds(config, runtimes, includeImplicitRuntimePreferences);

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
