function formatJsonPath(root: string, path: readonly (string | number)[]): string {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      current = `${current}[${segment}]`;
      continue;
    }
    current = current ? `${current}.${segment}` : segment;
  }
  return current || root || "value";
}

function describeUnreadableJsonValue(root: string, path: readonly (string | number)[]): string {
  return `${formatJsonPath(root, path)} must be readable JSON-compatible data`;
}

function describeNonJsonCompatibleValueAtPath(
  value: unknown,
  root: string,
  path: readonly (string | number)[],
  stack: WeakSet<object>,
): string | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : `${formatJsonPath(root, path)} must be finite`;
  }
  if (typeof value !== "object") {
    return `${formatJsonPath(root, path)} must be JSON-compatible; got ${typeof value}`;
  }
  if (stack.has(value)) {
    return `${formatJsonPath(root, path)} must not contain circular references`;
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      let length: number;
      try {
        length = value.length;
      } catch {
        return describeUnreadableJsonValue(root, path);
      }

      for (let index = 0; index < length; index += 1) {
        let entry: unknown;
        try {
          entry = value[index];
        } catch {
          return describeUnreadableJsonValue(root, [...path, index]);
        }
        const issue = describeNonJsonCompatibleValueAtPath(entry, root, [...path, index], stack);
        if (issue) {
          return issue;
        }
      }
      return undefined;
    }

    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return describeUnreadableJsonValue(root, path);
    }

    for (const key of keys) {
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        return describeUnreadableJsonValue(root, [...path, key]);
      }
      const issue = describeNonJsonCompatibleValueAtPath(entry, root, [...path, key], stack);
      if (issue) {
        return issue;
      }
    }
    return undefined;
  } finally {
    stack.delete(value);
  }
}

export function describeNonJsonCompatibleValue(value: unknown, root = "value"): string | undefined {
  return describeNonJsonCompatibleValueAtPath(value, root, [], new WeakSet());
}
