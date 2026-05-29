import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin,
} from "../../plugins/provider-runtime.js";
import type { ProviderToolSchemaDiagnostic } from "../../plugins/types.js";
import type { AgentTool } from "../runtime/index.js";
import type { AnyAgentTool } from "../tools/common.js";
import { log } from "./logger.js";

type ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> = {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
  allowRuntimePluginLoad?: boolean;
};

function buildProviderToolSchemaContext<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  params: ProviderToolSchemaParams<TSchemaType, TResult>,
  provider: string,
) {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    tools: params.tools as unknown as AnyAgentTool[],
  };
}

/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
export function normalizeProviderToolSchemas<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const provider = params.provider.trim();
  let pluginNormalized: unknown;
  try {
    pluginNormalized = normalizeProviderToolSchemasWithPlugin({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: buildProviderToolSchemaContext(params, provider),
    });
  } catch (error) {
    log.warn(`provider tool schema normalization failed for ${provider}: ${formatError(error)}`, {
      provider,
      toolCount: safeArrayLength(params.tools),
    });
    return params.tools;
  }
  return Array.isArray(pluginNormalized)
    ? (pluginNormalized as AgentTool<TSchemaType, TResult>[])
    : params.tools;
}

/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void {
  const provider = params.provider.trim();
  let diagnostics: unknown;
  try {
    diagnostics = inspectProviderToolSchemasWithPlugin({
      provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      runtimeHandle: params.runtimeHandle,
      allowRuntimePluginLoad: params.allowRuntimePluginLoad,
      context: buildProviderToolSchemaContext(params, provider),
    });
  } catch (error) {
    log.warn(`provider tool schema diagnostics failed for ${provider}: ${formatError(error)}`, {
      provider,
      toolCount: safeArrayLength(params.tools),
    });
    return;
  }
  if (!Array.isArray(diagnostics)) {
    return;
  }
  const normalizedDiagnostics = normalizeProviderToolSchemaDiagnostics(diagnostics);
  if (normalizedDiagnostics.length === 0) {
    return;
  }

  const summary = summarizeProviderToolSchemaDiagnostics(normalizedDiagnostics);
  log.warn(
    `provider tool schema diagnostics: ${normalizedDiagnostics.length} ${normalizedDiagnostics.length === 1 ? "tool" : "tools"} for ${params.provider}: ${summary}`,
    {
      provider: params.provider,
      toolCount: safeArrayLength(params.tools),
      diagnosticCount: normalizedDiagnostics.length,
      tools: copyToolNames(params.tools),
      diagnostics: normalizedDiagnostics.map((diagnostic) => ({
        index: diagnostic.toolIndex,
        tool: diagnostic.toolName,
        violations: diagnostic.violations.slice(0, 12),
        violationCount: diagnostic.violations.length,
      })),
    },
  );
}

function formatError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string" && message) {
        return message;
      }
      const name = error.name;
      return typeof name === "string" && name ? name : "unknown error";
    }
    const message = String(error);
    return message || "unknown error";
  } catch {
    return "unknown error";
  }
}

function safeArrayLength(values: readonly unknown[]): number {
  try {
    return values.length;
  } catch {
    return 0;
  }
}

function copyArrayEntries<T>(values: readonly T[]): T[] | undefined {
  try {
    const entries: T[] = [];
    const length = values.length;
    for (let index = 0; index < length; index += 1) {
      entries.push(values[index]);
    }
    return entries;
  } catch {
    return undefined;
  }
}

function copyToolNames(tools: readonly AgentTool[]): string[] {
  const entries = copyArrayEntries(tools);
  if (!entries) {
    return [];
  }
  const names: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    let name = "unknown";
    try {
      const value = entries[index]?.name;
      if (typeof value === "string" && value.trim()) {
        name = value;
      }
    } catch {
      name = "unreadable";
    }
    names.push(`${index}:${name}`);
  }
  return names;
}

function normalizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaDiagnostic[],
): ProviderToolSchemaDiagnostic[] {
  const entries = copyArrayEntries(diagnostics);
  if (!entries) {
    return [];
  }
  const normalized: ProviderToolSchemaDiagnostic[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const diagnostic = normalizeProviderToolSchemaDiagnostic(entries[index], index);
    if (diagnostic) {
      normalized.push(diagnostic);
    }
  }
  return normalized;
}

function normalizeProviderToolSchemaDiagnostic(
  diagnostic: unknown,
  diagnosticIndex: number,
): ProviderToolSchemaDiagnostic | undefined {
  if (!diagnostic || typeof diagnostic !== "object") {
    return undefined;
  }
  const record = diagnostic as ProviderToolSchemaDiagnostic;
  let toolIndex: number | undefined;
  try {
    toolIndex = typeof record.toolIndex === "number" ? record.toolIndex : undefined;
  } catch {
    toolIndex = undefined;
  }
  let toolName = `tool[${toolIndex ?? diagnosticIndex}]`;
  try {
    if (typeof record.toolName === "string" && record.toolName.trim()) {
      toolName = record.toolName;
    }
  } catch {
    // Keep the stable fallback name.
  }
  let violations: string[];
  try {
    const value = record.violations;
    violations = Array.isArray(value)
      ? (copyArrayEntries(value)?.filter((entry): entry is string => typeof entry === "string") ??
        [])
      : [];
  } catch {
    violations = [];
  }
  if (violations.length === 0) {
    violations = [`${toolName}.diagnostic`];
  }
  return { toolName, toolIndex, violations };
}

function summarizeProviderToolSchemaDiagnostics(
  diagnostics: readonly ProviderToolSchemaDiagnostic[],
) {
  const visible = diagnostics.slice(0, 6).map((diagnostic) => {
    const violationCount = diagnostic.violations.length;
    return `${diagnostic.toolName || "unknown"} (${violationCount} ${violationCount === 1 ? "violation" : "violations"})`;
  });
  const remaining = diagnostics.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
}
