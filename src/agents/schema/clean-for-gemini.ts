// Cloud Code Assist API rejects a subset of JSON Schema keywords.
// This module scrubs/normalizes tool schemas to keep Gemini happy.

import type { TSchema } from "typebox";

// Keywords that Cloud Code Assist API rejects (not compliant with their JSON Schema subset)
export const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  // Non-standard (OpenAPI) keyword; Claude validators reject it.
  "examples",

  // Cloud Code Assist appears to validate tool schemas more strictly/quirkily than
  // draft 2020-12 in practice; these constraints frequently trigger 400s.
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",

  // JSON Schema composition keywords not supported by OpenAPI 3.0 subset.
  // `const` is handled separately (converted to enum) in the cleaning loop,
  // but `not` has no safe equivalent and must be stripped.
  "not",
]);

const SCHEMA_META_KEYS = ["description", "title", "default"] as const;

function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of SCHEMA_META_KEYS) {
    const value = readRecordValue(from, key);
    if (value !== undefined) {
      to[key] = value;
    }
  }
}

// Check if an anyOf/oneOf array contains only literal values that can be flattened.
// TypeBox Type.Literal generates { const: "value", type: "string" }.
// Some schemas may use { enum: ["value"], type: "string" }.
// Both patterns are flattened to { type: "string", enum: ["a", "b", ...] }.
function tryFlattenLiteralAnyOf(variants: unknown[]): { type: string; enum: unknown[] } | null {
  if (variants.length === 0) {
    return null;
  }

  const allValues: unknown[] = [];
  let commonType: string | null = null;

  for (const variant of variants) {
    if (!variant || typeof variant !== "object") {
      return null;
    }
    const v = variant as Record<string, unknown>;

    let literalValue: unknown;
    if (hasRecordKey(v, "const")) {
      literalValue = readRecordValue(v, "const");
    } else {
      const enumValue = readRecordValue(v, "enum");
      if (!Array.isArray(enumValue)) {
        return null;
      }
      const enumEntries = copyArrayEntries(enumValue);
      if (!enumEntries || enumEntries.length !== 1) {
        return null;
      }
      literalValue = enumEntries[0];
    }

    const typeValue = readRecordValue(v, "type");
    const variantType = typeof typeValue === "string" ? typeValue : null;
    if (!variantType) {
      return null;
    }
    if (commonType === null) {
      commonType = variantType;
    } else if (commonType !== variantType) {
      return null;
    }

    allValues.push(literalValue);
  }

  if (commonType && allValues.length > 0) {
    return { type: commonType, enum: allValues };
  }
  return null;
}

function isNullSchema(variant: unknown): boolean {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    return false;
  }
  const record = variant as Record<string, unknown>;
  if (hasRecordKey(record, "const") && readRecordValue(record, "const") === null) {
    return true;
  }
  const enumValue = readRecordValue(record, "enum");
  if (Array.isArray(enumValue)) {
    const enumEntries = copyArrayEntries(enumValue);
    return enumEntries?.length === 1 && enumEntries[0] === null;
  }
  const typeValue = readRecordValue(record, "type");
  if (typeValue === "null") {
    return true;
  }
  const typeEntries = Array.isArray(typeValue) ? copyArrayEntries(typeValue) : undefined;
  if (typeEntries?.length === 1 && typeEntries[0] === "null") {
    return true;
  }
  return false;
}

function stripNullVariants(variants: unknown[]): {
  variants: unknown[];
  stripped: boolean;
} {
  if (variants.length === 0) {
    return { variants, stripped: false };
  }
  const nonNull = variants.filter((variant) => !isNullSchema(variant));
  return {
    variants: nonNull,
    stripped: nonNull.length !== variants.length,
  };
}

type SchemaDefs = Map<string, unknown>;

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsValue = readRecordValue(schema, "$defs");
  const legacyDefsValue = readRecordValue(schema, "definitions");
  const defsEntry =
    defsValue && typeof defsValue === "object" && !Array.isArray(defsValue)
      ? (defsValue as Record<string, unknown>)
      : undefined;
  const legacyDefsEntry =
    legacyDefsValue && typeof legacyDefsValue === "object" && !Array.isArray(legacyDefsValue)
      ? (legacyDefsValue as Record<string, unknown>)
      : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next = defs ? new Map(defs) : new Map<string, unknown>();
  if (defsEntry) {
    for (const [key, value] of copyObjectEntries(defsEntry) ?? []) {
      next.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of copyObjectEntries(legacyDefsEntry) ?? []) {
      next.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function tryResolveLocalRef(ref: string, defs: SchemaDefs | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const name = decodeJsonPointerSegment(match[1] ?? "");
  if (!name) {
    return undefined;
  }
  return defs.get(name);
}

function simplifyUnionVariants(params: { obj: Record<string, unknown>; variants: unknown[] }): {
  variants: unknown[];
  simplified?: unknown;
} {
  const { obj, variants } = params;

  const { variants: nonNullVariants, stripped } = stripNullVariants(variants);

  const flattened = tryFlattenLiteralAnyOf(nonNullVariants);
  if (flattened) {
    const result: Record<string, unknown> = {
      type: flattened.type,
      enum: flattened.enum,
    };
    copySchemaMeta(obj, result);
    return { variants: nonNullVariants, simplified: result };
  }

  if (stripped && nonNullVariants.length === 1) {
    const lone = nonNullVariants[0];
    if (lone && typeof lone === "object" && !Array.isArray(lone)) {
      const result = cloneRecord(lone as Record<string, unknown>) ?? {};
      copySchemaMeta(obj, result);
      return { variants: nonNullVariants, simplified: result };
    }
    return { variants: nonNullVariants, simplified: lone };
  }

  return { variants: stripped ? nonNullVariants : variants };
}

// Gemini rejects object schemas whose `required` entries do not exist in `properties`.
function sanitizeRequiredFields(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.required)) {
    return schema;
  }

  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    if (schema.type === "object") {
      delete schema.required;
    }
    return schema;
  }

  const properties = schema.properties as Record<string, unknown>;
  const requiredEntries = copyArrayEntries(schema.required);
  if (!requiredEntries) {
    delete schema.required;
    return schema;
  }
  const required = requiredEntries.filter(
    (key): key is string => typeof key === "string" && Object.hasOwn(properties, key),
  );

  if (required.length > 0) {
    schema.required = required;
  } else {
    delete schema.required;
  }

  return schema;
}

function cleanSchemaMapForGemini(
  value: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const entries = copyObjectEntries(value as Record<string, unknown>);
  if (!entries) {
    return {};
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, cleanSchemaForGeminiWithDefs(entry, defs, refStack)]),
  );
}

function cleanSchemaArrayForGemini(
  value: unknown[],
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown[] | undefined {
  const entries = copyArrayEntries(value);
  return entries?.map((entry) => cleanSchemaForGeminiWithDefs(entry, defs, refStack));
}

function cleanDependenciesForGemini(
  value: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const entries = copyObjectEntries(value as Record<string, unknown>);
  if (!entries) {
    return {};
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? (copyArrayEntries(entry) ?? [])
        : cleanSchemaForGeminiWithDefs(entry, defs, refStack),
    ]),
  );
}

const SCHEMA_OBJECT_KEYS = new Set([
  "additionalItems",
  "contains",
  "else",
  "if",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function cleanSchemaForGeminiWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    const entries = cleanSchemaArrayForGemini(schema, defs, refStack);
    return entries ?? [];
  }

  const obj = schema as Record<string, unknown>;
  const nextDefs = extendSchemaDefs(defs, obj);

  const rawRefValue = readRecordValue(obj, "$ref");
  const refValue = typeof rawRefValue === "string" ? rawRefValue : undefined;
  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }

    const resolved = tryResolveLocalRef(refValue, nextDefs);
    if (resolved) {
      const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
      nextRefStack.add(refValue);

      const cleaned = cleanSchemaForGeminiWithDefs(resolved, nextDefs, nextRefStack);
      if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
        return cleaned;
      }

      const result = cloneRecord(cleaned as Record<string, unknown>) ?? {};
      copySchemaMeta(obj, result);
      return result;
    }

    const result: Record<string, unknown> = {};
    copySchemaMeta(obj, result);
    return result;
  }

  const anyOfValue = readRecordValue(obj, "anyOf");
  const oneOfValue = readRecordValue(obj, "oneOf");
  let cleanedAnyOf = Array.isArray(anyOfValue)
    ? cleanSchemaArrayForGemini(anyOfValue, nextDefs, refStack)
    : undefined;
  const hasAnyOf = cleanedAnyOf !== undefined;
  let cleanedOneOf = Array.isArray(oneOfValue)
    ? cleanSchemaArrayForGemini(oneOfValue, nextDefs, refStack)
    : undefined;
  const hasOneOf = cleanedOneOf !== undefined;

  if (cleanedAnyOf !== undefined) {
    const simplified = simplifyUnionVariants({ obj, variants: cleanedAnyOf });
    cleanedAnyOf = simplified.variants;
    if ("simplified" in simplified) {
      return simplified.simplified;
    }
  }

  if (cleanedOneOf !== undefined) {
    const simplified = simplifyUnionVariants({ obj, variants: cleanedOneOf });
    cleanedOneOf = simplified.variants;
    if ("simplified" in simplified) {
      return simplified.simplified;
    }
  }

  const cleaned: Record<string, unknown> = {};

  const entries = copyObjectEntries(obj);
  if (!entries) {
    return {};
  }

  for (const [key, value] of entries) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    if (key === "const") {
      cleaned.enum = [value];
      continue;
    }

    // Google's schema validator rejects `"required": []` — omit empty arrays.
    if (key === "required" && Array.isArray(value)) {
      const requiredEntries = copyArrayEntries(value);
      if (!requiredEntries || requiredEntries.length === 0) {
        continue;
      }
      cleaned.required = requiredEntries;
      continue;
    }

    if (key === "type" && (hasAnyOf || hasOneOf)) {
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const typeEntries = copyArrayEntries(value);
      if (typeEntries?.every((entry) => typeof entry === "string")) {
        const types = typeEntries.filter((entry) => entry !== "null");
        cleaned.type = types.length === 1 ? types[0] : types;
      }
      continue;
    }

    if (key === "properties") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const props = value as Record<string, unknown>;
        const propEntries = copyObjectEntries(props);
        cleaned[key] = propEntries
          ? Object.fromEntries(
              propEntries.map(([k, v]) => [k, cleanSchemaForGeminiWithDefs(v, nextDefs, refStack)]),
            )
          : {};
      } else {
        // Guard malformed schemas (e.g. properties: null) that can trigger
        // downstream Object.* crashes in strict provider validators.
        cleaned[key] = {};
      }
    } else if (key === "items" && value) {
      if (Array.isArray(value)) {
        const entries = cleanSchemaArrayForGemini(value, nextDefs, refStack);
        if (entries) {
          cleaned[key] = entries;
        }
      } else if (typeof value === "object") {
        cleaned[key] = cleanSchemaForGeminiWithDefs(value, nextDefs, refStack);
      } else {
        cleaned[key] = value;
      }
    } else if (key === "anyOf" && Array.isArray(value)) {
      if (hasAnyOf) {
        cleaned[key] = cleanedAnyOf;
      }
    } else if (key === "oneOf" && Array.isArray(value)) {
      if (hasOneOf) {
        cleaned[key] = cleanedOneOf;
      }
    } else if (key === "allOf" && Array.isArray(value)) {
      const entries = cleanSchemaArrayForGemini(value, nextDefs, refStack);
      if (entries) {
        cleaned[key] = entries;
      }
    } else if (key === "prefixItems" && Array.isArray(value)) {
      const entries = cleanSchemaArrayForGemini(value, nextDefs, refStack);
      if (entries) {
        cleaned[key] = entries;
      }
    } else if (key === "dependentSchemas") {
      cleaned[key] = cleanSchemaMapForGemini(value, nextDefs, refStack);
    } else if (key === "dependencies") {
      cleaned[key] = cleanDependenciesForGemini(value, nextDefs, refStack);
    } else if (SCHEMA_OBJECT_KEYS.has(key)) {
      cleaned[key] = cleanSchemaForGeminiWithDefs(value, nextDefs, refStack);
    } else {
      cleaned[key] = value;
    }
  }

  // Cloud Code Assist API rejects anyOf/oneOf in nested schemas even after
  // simplifyUnionVariants runs above. Flatten remaining unions as a fallback:
  // pick the common type or use the first variant's type so the tool
  // declaration is accepted by Google's validation layer.
  if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
    const flattened = flattenUnionFallback(cleaned, cleaned.anyOf);
    if (flattened) {
      return sanitizeRequiredFields(flattened);
    }
  }
  if (cleaned.oneOf && Array.isArray(cleaned.oneOf)) {
    const flattened = flattenUnionFallback(cleaned, cleaned.oneOf);
    if (flattened) {
      return sanitizeRequiredFields(flattened);
    }
  }

  return sanitizeRequiredFields(cleaned);
}

/**
 * Last-resort flattening for anyOf/oneOf arrays that could not be simplified
 * by `simplifyUnionVariants`. Picks a representative type so the schema is
 * accepted by Google's restricted JSON Schema validation.
 */
function flattenUnionFallback(
  obj: Record<string, unknown>,
  variants: unknown[],
): Record<string, unknown> | undefined {
  const objects = variants.filter(
    (v): v is Record<string, unknown> => !!v && typeof v === "object",
  );
  if (objects.length === 0) {
    return undefined;
  }
  const types = new Set(
    objects
      .map((v) => readRecordValue(v, "type"))
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  if (objects.length === 1) {
    const merged = cloneRecord(objects[0]) ?? {};
    copySchemaMeta(obj, merged);
    return merged;
  }
  if (types.size === 1) {
    const merged: Record<string, unknown> = { type: Array.from(types)[0] };
    copySchemaMeta(obj, merged);
    return merged;
  }
  const first = objects[0];
  const firstType = first ? readRecordValue(first, "type") : undefined;
  if (firstType) {
    const merged: Record<string, unknown> = { type: firstType };
    copySchemaMeta(obj, merged);
    return merged;
  }
  const merged: Record<string, unknown> = {};
  copySchemaMeta(obj, merged);
  return merged;
}

export function cleanSchemaForGemini(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") {
    return schema as TSchema;
  }
  if (Array.isArray(schema)) {
    const entries = copyArrayEntries(schema);
    return (entries ? entries.map(cleanSchemaForGemini) : []) as TSchema;
  }

  const defs = extendSchemaDefs(undefined, schema as Record<string, unknown>);
  return cleanSchemaForGeminiWithDefs(schema, defs, undefined) as TSchema;
}

function hasRecordKey(record: Record<string, unknown>, key: string): boolean {
  try {
    return key in record;
  } catch {
    return false;
  }
}

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function copyObjectEntries(record: Record<string, unknown>): Array<[string, unknown]> | undefined {
  try {
    return Object.entries(record);
  } catch {
    return undefined;
  }
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = copyObjectEntries(record);
  return entries ? Object.fromEntries(entries) : undefined;
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
