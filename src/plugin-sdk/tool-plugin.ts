import { Type, type Static, type TSchema } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "../agents/runtime/index.js";
import { jsonResult, textResult } from "../agents/tools/common.js";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import { describeNonJsonCompatibleValue } from "../shared/json-compatible.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "./plugin-entry.js";

const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback;
};

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema
  ? Static<TConfigSchema>
  : Record<string, never>;

type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolPluginToolDefinition<TConfig, TParamsSchema>,
) => DefinedToolPluginTool;

export type ToolPluginFactoryContext<TConfig> = {
  api: OpenClawPluginApi;
  config: TConfig;
  toolContext: OpenClawPluginToolContext;
};

type ToolPluginToolDefinitionBase<TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
};

export type ToolPluginToolDefinition<
  TConfig,
  TParamsSchema extends TSchema,
> = ToolPluginToolDefinitionBase<TParamsSchema> &
  (
    | {
        execute: (
          params: Static<TParamsSchema>,
          config: TConfig,
          context: ToolPluginExecutionContext,
        ) => unknown;
        factory?: never;
      }
    | {
        factory: (
          context: ToolPluginFactoryContext<TConfig>,
        ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
        execute?: never;
      }
  );

type DefinedToolPluginTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
  factory?: (
    context: ToolPluginFactoryContext<unknown>,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};

type ToolPluginToolField = keyof DefinedToolPluginTool;

function readToolPluginToolField(
  tool: unknown,
  key: ToolPluginToolField,
): { readable: true; value: unknown } | { readable: false } {
  try {
    return {
      readable: true,
      value: (tool as Record<ToolPluginToolField, unknown>)[key],
    };
  } catch {
    return { readable: false };
  }
}

function requireReadableToolPluginToolField(
  tool: unknown,
  key: ToolPluginToolField,
  owner: string,
): unknown {
  const read = readToolPluginToolField(tool, key);
  if (!read.readable) {
    throw new Error(`${owner} ${key} must be readable`);
  }
  return read.value;
}

function normalizeDefinedToolPluginTool(tool: unknown): DefinedToolPluginTool {
  if (!tool || typeof tool !== "object") {
    throw new Error("tool plugin tool must be an object");
  }

  const name = requireReadableToolPluginToolField(tool, "name", "tool plugin tool");
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("tool plugin tool name must be a non-empty string");
  }
  const owner = `tool plugin tool ${name}`;
  const label = requireReadableToolPluginToolField(tool, "label", owner);
  if (label !== undefined && typeof label !== "string") {
    throw new Error(`${owner} label must be a string`);
  }
  const description = requireReadableToolPluginToolField(tool, "description", owner);
  if (typeof description !== "string") {
    throw new Error(`${owner} description must be a string`);
  }
  const parameters = requireReadableToolPluginToolField(tool, "parameters", owner);
  const optional = requireReadableToolPluginToolField(tool, "optional", owner);
  const execute = requireReadableToolPluginToolField(tool, "execute", owner);
  const factory = requireReadableToolPluginToolField(tool, "factory", owner);

  return {
    name,
    label: label ?? name,
    description,
    parameters: parameters as TSchema,
    optional: optional === true,
    ...(typeof execute === "function"
      ? { execute: execute as DefinedToolPluginTool["execute"] }
      : {}),
    ...(typeof factory === "function"
      ? { factory: factory as DefinedToolPluginTool["factory"] }
      : {}),
  };
}

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
};

export type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
};

export type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
  id: string;
  name: string;
  description: string;
  activation?: PluginManifestActivation;
  configSchema?: TConfigSchema;
  tools: (
    tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>,
  ) => readonly DefinedToolPluginTool[];
};

export type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
  [toolPluginMetadataSymbol]: ToolPluginMetadata;
};

function wrapToolPluginResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return textResult(result, result);
  }
  return jsonResult(result);
}

function assertJsonCompatibleSchemaObject(
  value: unknown,
  owner: string,
): asserts value is JsonSchemaObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${owner} must be a JSON-compatible schema object`);
  }
  const issue = describeNonJsonCompatibleValue(value, "schema");
  if (issue) {
    throw new Error(`${owner} must be a JSON-compatible schema object: ${issue}`);
  }
}

function createToolPluginToolFactory<TConfig>(): ToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) =>
    normalizeDefinedToolPluginTool(definition)) as ToolPluginToolFactory<TConfig>;
}

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const configSchema = definition.configSchema ?? EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA;
  assertJsonCompatibleSchemaObject(configSchema, "tool plugin configSchema");
  const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
  const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
  const tools = [
    ...definition.tools(createToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>()),
  ].map((tool) => normalizeDefinedToolPluginTool(tool));
  for (const tool of tools) {
    const toolName = typeof tool.name === "string" && tool.name.trim() ? tool.name : "<unnamed>";
    assertJsonCompatibleSchemaObject(tool.parameters, `tool plugin tool ${toolName} parameters`);
  }
  const activation = definition.activation ?? { onStartup: true };
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation,
    configSchema: normalizedConfigSchema,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as JsonSchemaObject,
      ...(tool.optional ? { optional: true } : {}),
    })),
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as ToolPluginConfig<TConfigSchema>;
      for (const tool of tools) {
        const opts = {
          name: tool.name,
          ...(tool.optional ? { optional: true } : {}),
        };
        if (tool.factory) {
          api.registerTool(
            (toolContext) =>
              tool.factory?.({
                api,
                config,
                toolContext,
              }),
            opts,
          );
          continue;
        }
        const execute = tool.execute;
        if (!execute) {
          throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        }
        api.registerTool(
          {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (toolCallId, params, signal, onUpdate) =>
              wrapToolPluginResult(
                await execute(params, config, {
                  api,
                  signal,
                  toolCallId,
                  onUpdate,
                }),
              ),
          },
          tool.optional ? { optional: true } : undefined,
        );
      }
    },
  }) as DefinedToolPluginEntry;

  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });
  return entry;
}

export function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const metadata = (entry as { [toolPluginMetadataSymbol]?: unknown })[toolPluginMetadataSymbol];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return metadata as ToolPluginMetadata;
}
