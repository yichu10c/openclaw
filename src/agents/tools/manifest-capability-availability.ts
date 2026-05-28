import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "../../plugins/manifest-tool-availability.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../../plugins/runtime-state.js";
import { listProfilesForProvider } from "../auth-profiles/profile-list.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

export type CapabilityContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "mediaUnderstandingProviders";

type CapabilityProviderMetadataKey =
  | "imageGenerationProviderMetadata"
  | "videoGenerationProviderMetadata"
  | "musicGenerationProviderMetadata";
type CapabilityConfigSignal = Parameters<typeof manifestConfigSignalPasses>[0]["signal"];
type CapabilityProviderBaseUrl = Parameters<typeof manifestProviderBaseUrlGuardPasses>[0]["guard"];

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
      // Skip unreadable manifest metadata entries; later providers can still prove availability.
    }
  }
  return entries;
}

function copyStringArrayEntries(value: unknown): string[] {
  return copyArrayEntries(value).filter((entry): entry is string => typeof entry === "string");
}

function metadataKeyForCapabilityContract(
  key: CapabilityContractKey,
): CapabilityProviderMetadataKey | undefined {
  switch (key) {
    case "imageGenerationProviders":
      return "imageGenerationProviderMetadata";
    case "videoGenerationProviders":
      return "videoGenerationProviderMetadata";
    case "musicGenerationProviders":
      return "musicGenerationProviderMetadata";
    case "mediaUnderstandingProviders":
      return undefined;
  }
  return undefined;
}

function listCapabilityAuthSignals(params: {
  plugin: PluginManifestRecord;
  key: CapabilityContractKey;
  providerId: string;
}): Array<{
  provider: string;
  providerBaseUrl?: NonNullable<
    NonNullable<PluginManifestRecord["imageGenerationProviderMetadata"]>[string]["authSignals"]
  >[number]["providerBaseUrl"];
}> {
  const metadata = readCapabilityProviderMetadata(params.plugin, params.key, params.providerId);
  const authSignals = copyArrayEntries(readRecordValue(metadata, "authSignals"))
    .filter(isRecord)
    .flatMap((signal) => {
      const provider = readRecordValue(signal, "provider");
      if (typeof provider !== "string") {
        return [];
      }
      const providerBaseUrl = readRecordValue(signal, "providerBaseUrl") as
        | CapabilityProviderBaseUrl
        | undefined;
      return [{ provider, ...(providerBaseUrl ? { providerBaseUrl } : {}) }];
    });
  if (authSignals.length > 0) {
    return authSignals;
  }
  return [
    params.providerId,
    ...copyStringArrayEntries(readRecordValue(metadata, "aliases")),
    ...copyStringArrayEntries(readRecordValue(metadata, "authProviders")),
  ].map((provider) => ({ provider }));
}

function readCapabilityProviderMetadata(
  plugin: PluginManifestRecord,
  key: CapabilityContractKey,
  providerId: string,
): Record<string, unknown> | undefined {
  const metadataKey = metadataKeyForCapabilityContract(key);
  const metadata = metadataKey
    ? readRecordValue(readRecordValue(plugin, metadataKey), providerId)
    : undefined;
  return isRecord(metadata) ? metadata : undefined;
}

function listCapabilityProviderIds(
  plugin: PluginManifestRecord,
  key: CapabilityContractKey,
): string[] {
  return copyStringArrayEntries(readRecordValue(readRecordValue(plugin, "contracts"), key));
}

function listCapabilityConfigSignals(metadata: unknown): CapabilityConfigSignal[] {
  return copyArrayEntries(readRecordValue(metadata, "configSignals")).filter(
    (signal): signal is CapabilityConfigSignal => isRecord(signal),
  );
}

function capabilityConfigSignalPasses(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  signal: CapabilityConfigSignal;
}): boolean {
  try {
    return manifestConfigSignalPasses(params);
  } catch {
    return false;
  }
}

function providerBaseUrlGuardPasses(params: {
  config?: OpenClawConfig;
  guard: CapabilityProviderBaseUrl;
}): boolean {
  try {
    return manifestProviderBaseUrlGuardPasses(params);
  } catch {
    return false;
  }
}

function hasManifestProviderEnvSignal(
  env: NodeJS.ProcessEnv,
  plugin: PluginManifestRecord,
  providerId: string,
): boolean {
  try {
    return hasNonEmptyManifestEnvCandidate(
      env,
      manifestPluginSetupProviderEnvVars(plugin, providerId),
    );
  } catch {
    return false;
  }
}

export function getCurrentCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

export function loadCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env: params.env ?? process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

export function hasSnapshotCapabilityAvailability(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  key: CapabilityContractKey;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    for (const providerId of listCapabilityProviderIds(plugin, params.key)) {
      const metadata = readCapabilityProviderMetadata(plugin, params.key, providerId);
      if (
        listCapabilityConfigSignals(metadata).some((signal) =>
          capabilityConfigSignalPasses({
            config: params.config,
            env: process.env,
            signal,
          }),
        )
      ) {
        return true;
      }
      for (const signal of listCapabilityAuthSignals({
        plugin,
        key: params.key,
        providerId,
      })) {
        if (
          !providerBaseUrlGuardPasses({
            config: params.config,
            guard: signal.providerBaseUrl,
          })
        ) {
          continue;
        }
        if (
          params.authStore &&
          listProfilesForProvider(params.authStore, signal.provider).length > 0
        ) {
          return true;
        }
        if (hasManifestProviderEnvSignal(process.env, plugin, signal.provider)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function hasSnapshotProviderEnvAvailability(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  providerId: string;
  config?: OpenClawConfig;
}): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    if (
      hasNonEmptyManifestEnvCandidate(
        process.env,
        manifestPluginSetupProviderEnvVars(plugin, params.providerId),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function hasSnapshotCapabilityProviderAvailability(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  key: CapabilityContractKey;
  providerId: string;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    if (!listCapabilityProviderIds(plugin, params.key).includes(params.providerId)) {
      continue;
    }
    const metadata = readCapabilityProviderMetadata(plugin, params.key, params.providerId);
    if (
      listCapabilityConfigSignals(metadata).some((signal) =>
        capabilityConfigSignalPasses({
          config: params.config,
          env: process.env,
          signal,
        }),
      )
    ) {
      return true;
    }
    for (const signal of listCapabilityAuthSignals({
      plugin,
      key: params.key,
      providerId: params.providerId,
    })) {
      if (
        !providerBaseUrlGuardPasses({
          config: params.config,
          guard: signal.providerBaseUrl,
        })
      ) {
        continue;
      }
      if (
        params.authStore &&
        listProfilesForProvider(params.authStore, signal.provider).length > 0
      ) {
        return true;
      }
      if (hasManifestProviderEnvSignal(process.env, plugin, signal.provider)) {
        return true;
      }
    }
  }
  return false;
}
