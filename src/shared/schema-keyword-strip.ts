export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    const entries = copyArrayEntries(schema);
    return entries
      ? entries.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords))
      : [];
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  const entries = copyObjectEntries(obj);
  if (!entries) {
    return {};
  }
  for (const [key, value] of entries) {
    if (unsupportedKeywords.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propertyEntries = copyObjectEntries(value as Record<string, unknown>);
      cleaned[key] = propertyEntries
        ? Object.fromEntries(
            propertyEntries.map(([childKey, childValue]) => [
              childKey,
              stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords),
            ]),
          )
        : {};
      continue;
    }
    if (
      (key === "$defs" ||
        key === "definitions" ||
        key === "dependentSchemas" ||
        key === "patternProperties") &&
      isSchemaMap(value)
    ) {
      const mapEntries = copyObjectEntries(value);
      cleaned[key] = mapEntries
        ? Object.fromEntries(
            mapEntries.map(([childKey, childValue]) => [
              childKey,
              stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords),
            ]),
          )
        : {};
      continue;
    }
    if (key === "dependencies" && isSchemaMap(value)) {
      const mapEntries = copyObjectEntries(value);
      cleaned[key] = mapEntries
        ? Object.fromEntries(
            mapEntries.map(([childKey, childValue]) => [
              childKey,
              Array.isArray(childValue)
                ? (copyArrayEntries(childValue) ?? [])
                : stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords),
            ]),
          )
        : {};
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      if (Array.isArray(value)) {
        const itemEntries = copyArrayEntries(value);
        if (itemEntries) {
          cleaned[key] = itemEntries.map((entry) =>
            stripUnsupportedSchemaKeywords(entry, unsupportedKeywords),
          );
        }
      } else {
        cleaned[key] = stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
      }
      continue;
    }
    if (key === "prefixItems" && Array.isArray(value)) {
      const itemEntries = copyArrayEntries(value);
      if (itemEntries) {
        cleaned[key] = itemEntries.map((entry) =>
          stripUnsupportedSchemaKeywords(entry, unsupportedKeywords),
        );
      }
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      const variantEntries = copyArrayEntries(value);
      if (variantEntries) {
        cleaned[key] = variantEntries.map((entry) =>
          stripUnsupportedSchemaKeywords(entry, unsupportedKeywords),
        );
      }
      continue;
    }
    if (SCHEMA_OBJECT_KEYWORDS.has(key)) {
      cleaned[key] = stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function isSchemaMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const SCHEMA_OBJECT_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

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

function copyObjectEntries(record: Record<string, unknown>): Array<[string, unknown]> | undefined {
  try {
    return Object.entries(record);
  } catch {
    return undefined;
  }
}
