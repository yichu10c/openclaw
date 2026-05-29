import type { ModelCompatConfig } from "../config/types.models.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";

type ToolSchemaCompatInput = {
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

type ToolWithParameters = {
  name?: unknown;
  parameters: unknown;
};

type ToolParametersRead =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    };

function resolveToolSchemaModelCompat(
  compat: ToolSchemaCompatInput | null | undefined,
): ModelCompatConfig | undefined {
  if (!compat) {
    return undefined;
  }
  const unsupportedToolSchemaKeywords = Array.isArray(compat.unsupportedToolSchemaKeywords)
    ? compat.unsupportedToolSchemaKeywords.filter(
        (keyword): keyword is string => typeof keyword === "string",
      )
    : [];
  if (unsupportedToolSchemaKeywords.length === 0 && compat.omitEmptyArrayItems !== true) {
    return undefined;
  }
  return {
    ...(unsupportedToolSchemaKeywords.length > 0 ? { unsupportedToolSchemaKeywords } : {}),
    ...(compat.omitEmptyArrayItems === true ? { omitEmptyArrayItems: true } : {}),
  };
}

export function normalizeStrictOpenAIJsonSchema(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): unknown {
  return normalizeStrictOpenAIJsonSchemaRecursive(
    normalizeToolParameterSchema(schema ?? {}, {
      modelCompat: resolveToolSchemaModelCompat(modelCompat),
    }),
    0,
  );
}

function normalizeStrictOpenAIJsonSchemaRecursive(schema: unknown, depth: number): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeStrictOpenAIJsonSchemaRecursive(entry, depth);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = normalizeStrictOpenAIJsonSchemaRecursive(
      value,
      key === "properties" ? depth : depth + 1,
    );
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (normalized.type === "object") {
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? (normalized.properties as Record<string, unknown>)
        : undefined;
    if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
      normalized.required = [];
      changed = true;
    }
    if (depth === 0 && !("additionalProperties" in normalized)) {
      normalized.additionalProperties = false;
      changed = true;
    }
  }

  return changed ? normalized : schema;
}

export function normalizeOpenAIStrictToolParameters<T>(
  schema: T,
  strict: boolean,
  modelCompat?: ToolSchemaCompatInput | null,
): T {
  const toolSchemaCompat = resolveToolSchemaModelCompat(modelCompat);
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}, { modelCompat: toolSchemaCompat }) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema, toolSchemaCompat) as T;
}

export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema));
}

type OpenAIStrictToolSchemaDiagnostic = {
  toolIndex: number;
  toolName?: string;
  violations: string[];
};

function readOpenAIToolName(tool: ToolWithParameters): string | undefined {
  try {
    const name = tool.name;
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

function readOpenAIToolParameters(tool: ToolWithParameters): ToolParametersRead {
  try {
    return { ok: true, value: tool.parameters };
  } catch {
    return { ok: false };
  }
}

function formatOpenAIToolSchemaDiagnosticPath(toolName: string | undefined, toolIndex: number) {
  return `${toolName ?? `tool[${toolIndex}]`}.parameters`;
}

export function findOpenAIStrictToolSchemaDiagnostics(
  tools: readonly ToolWithParameters[],
): OpenAIStrictToolSchemaDiagnostic[] {
  return tools.flatMap((tool, toolIndex) => {
    const toolName = readOpenAIToolName(tool);
    const diagnosticPath = formatOpenAIToolSchemaDiagnosticPath(toolName, toolIndex);
    const parameters = readOpenAIToolParameters(tool);
    if (!parameters.ok) {
      return [
        {
          toolIndex,
          ...(toolName ? { toolName } : {}),
          violations: [diagnosticPath],
        },
      ];
    }
    let violations: string[];
    try {
      violations = findStrictOpenAIJsonSchemaViolations(
        normalizeStrictOpenAIJsonSchema(parameters.value),
        diagnosticPath,
      );
    } catch {
      violations = [diagnosticPath];
    }
    if (violations.length === 0) {
      return [];
    }
    return [
      {
        toolIndex,
        ...(toolName ? { toolName } : {}),
        violations,
      },
    ];
  });
}

function isStrictOpenAIJsonSchemaCompatibleRecursive(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
  }
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
    return false;
  }
  if (Array.isArray(record.type)) {
    return false;
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    return false;
  }
  if (record.type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      return false;
    }
    const requiredSet = new Set(required);
    if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
      return false;
    }
  }

  return Object.entries(record).every(([key, entry]) => {
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.values(entry as Record<string, unknown>).every((value) =>
        isStrictOpenAIJsonSchemaCompatibleRecursive(value),
      );
    }
    return isStrictOpenAIJsonSchemaCompatibleRecursive(entry);
  });
}

function findStrictOpenAIJsonSchemaViolations(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findStrictOpenAIJsonSchemaViolations(entry, `${path}[${index}]`),
    );
  }
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in record) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }
  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  if (
    record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
  ) {
    for (const [key, value] of Object.entries(record.properties)) {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (value && typeof value === "object") {
      violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
}

export function resolveOpenAIStrictToolFlagForInventory(
  tools: readonly ToolWithParameters[],
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return tools.every((tool) => {
    const parameters = readOpenAIToolParameters(tool);
    if (!parameters.ok) {
      return false;
    }
    try {
      return isStrictOpenAIJsonSchemaCompatible(parameters.value);
    } catch {
      return false;
    }
  });
}
