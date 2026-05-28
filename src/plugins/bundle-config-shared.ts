import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchRootFileOpenFailure, type RootFileOpenFailure } from "../infra/boundary-file-read.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type ReadBundleJsonResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

export type BundleServerRuntimeSupport = {
  hasSupportedServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyServerEntries(
  value: unknown,
  diagnostics: string[],
): Array<[serverName: string, server: unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    diagnostics.push("unable to inspect bundle server map");
    return [];
  }
  const entries: Array<[serverName: string, server: unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, value[key]]);
    } catch {
      diagnostics.push(`unable to inspect bundle server ${key}`);
      entries.push([key, undefined]);
    }
  }
  return entries;
}

function readServerCommand(server: unknown, serverName: string, diagnostics: string[]): unknown {
  if (!isRecord(server)) {
    return undefined;
  }
  try {
    return server.command;
  } catch {
    diagnostics.push(`unable to inspect bundle server ${serverName} command`);
    return undefined;
  }
}

export function readBundleJsonObject(params: {
  rootDir: string;
  relativePath: string;
  onOpenFailure?: (failure: RootFileOpenFailure) => ReadBundleJsonResult;
}): ReadBundleJsonResult {
  const result = readRootJsonObjectSync({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (result.ok) {
    return { ok: true, raw: result.value };
  }
  if (result.reason === "open") {
    return params.onOpenFailure?.(result.failure) ?? { ok: true, raw: {} };
  }
  return { ok: false, error: result.error };
}

export function resolveBundleJsonOpenFailure(params: {
  failure: RootFileOpenFailure;
  relativePath: string;
  allowMissing?: boolean;
}): ReadBundleJsonResult {
  return matchRootFileOpenFailure(params.failure, {
    path: () => {
      if (params.allowMissing) {
        return { ok: true, raw: {} };
      }
      return { ok: false, error: `unable to read ${params.relativePath}: path` };
    },
    fallback: (failure) => ({
      ok: false,
      error: `unable to read ${params.relativePath}: ${failure.reason}`,
    }),
  });
}

export function inspectBundleServerRuntimeSupport<TConfig>(params: {
  loaded: { config: TConfig; diagnostics: string[] };
  resolveServers: (config: TConfig) => Record<string, Record<string, unknown>>;
}): BundleServerRuntimeSupport {
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  const diagnostics = [...params.loaded.diagnostics];
  let hasSupportedServer = false;
  let servers: unknown;
  try {
    servers = params.resolveServers(params.loaded.config);
  } catch {
    diagnostics.push("unable to inspect bundle server map");
    servers = {};
  }
  for (const [serverName, server] of copyServerEntries(servers, diagnostics)) {
    const command = readServerCommand(server, serverName, diagnostics);
    if (typeof command === "string" && command.trim().length > 0) {
      hasSupportedServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    hasSupportedServer,
    supportedServerNames,
    unsupportedServerNames,
    diagnostics,
  };
}

export function loadEnabledBundleConfig<TConfig, TDiagnostic>(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  createEmptyConfig: () => TConfig;
  loadBundleConfig: (params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  }) => { config: TConfig; diagnostics: string[] };
  createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): { config: TConfig; diagnostics: TDiagnostic[] } {
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  if (!normalizedPlugins.enabled) {
    return { config: params.createEmptyConfig(), diagnostics: [] };
  }

  const registry = loadPluginManifestRegistryForPluginRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    includeDisabled: true,
  });
  const diagnostics: TDiagnostic[] = [];
  let merged = params.createEmptyConfig();

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!activationState.activated) {
      continue;
    }

    const loaded = params.loadBundleConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as TConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push(params.createDiagnostic(record.id, message));
    }
  }

  return { config: merged, diagnostics };
}
