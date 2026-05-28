import type { OpenClawConfig } from "../config/types.openclaw.js";

const PLUGIN_CACHE_UNREADABLE_VALUE = "[Unreadable]";
const PLUGIN_CACHE_UNREADABLE_OBJECT = "[UnreadableObject]";
const PLUGIN_CACHE_CIRCULAR_VALUE = "[Circular]";

export type PluginLruCacheResult<T> = { hit: true; value: T } | { hit: false };

export class PluginLruCache<T> {
  readonly #defaultMaxEntries: number;
  #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(defaultMaxEntries: number) {
    this.#defaultMaxEntries = normalizeMaxEntries(defaultMaxEntries, 1);
    this.#maxEntries = this.#defaultMaxEntries;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  setMaxEntriesForTest(value?: number): void {
    this.#maxEntries =
      typeof value === "number"
        ? normalizeMaxEntries(value, this.#defaultMaxEntries)
        : this.#defaultMaxEntries;
    this.#evictOldestEntries();
  }

  clear(): void {
    this.#entries.clear();
  }

  get(cacheKey: string): T | undefined {
    const cached = this.getResult(cacheKey);
    return cached.hit ? cached.value : undefined;
  }

  getResult(cacheKey: string): PluginLruCacheResult<T> {
    if (!this.#entries.has(cacheKey)) {
      return { hit: false };
    }
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return { hit: true, value: cached };
  }

  set(cacheKey: string, value: T): void {
    if (this.#entries.has(cacheKey)) {
      this.#entries.delete(cacheKey);
    }
    this.#entries.set(cacheKey, value);
    this.#evictOldestEntries();
  }

  #evictOldestEntries(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldestEntry = this.#entries.keys().next();
      if (oldestEntry.done) {
        break;
      }
      this.#entries.delete(oldestEntry.value);
    }
  }
}

export type ConfigScopedRuntimeCache<T> = WeakMap<OpenClawConfig, Map<string, T>>;

export type ConfigScopedPromiseLoader<T> = {
  load(config?: OpenClawConfig): Promise<T>;
  clear(): void;
};

export function resolveConfigScopedRuntimeCacheValue<T>(params: {
  cache: ConfigScopedRuntimeCache<T>;
  config?: OpenClawConfig;
  key: string;
  load: () => T;
}): T {
  if (!params.config) {
    return params.load();
  }
  let configCache = params.cache.get(params.config);
  if (!configCache) {
    configCache = new Map();
    params.cache.set(params.config, configCache);
  }
  if (configCache.has(params.key)) {
    return configCache.get(params.key) as T;
  }
  const loaded = params.load();
  configCache.set(params.key, loaded);
  return loaded;
}

export function createPluginCacheKey(parts: readonly unknown[]): string {
  return stablePluginCacheValueKey(parts);
}

function stablePluginCacheValueKey(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `string:${JSON.stringify(value)}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${JSON.stringify(value)}`;
  }
  if (typeof value === "number") {
    return `number:${JSON.stringify(Number.isFinite(value) ? value : String(value))}`;
  }
  if (typeof value === "bigint") {
    return `bigint:${JSON.stringify(value.toString())}`;
  }
  if (typeof value !== "object") {
    return `${typeof value}:${JSON.stringify(`[${typeof value}]`)}`;
  }
  if (stack.has(value)) {
    return `circular:${JSON.stringify(PLUGIN_CACHE_CIRCULAR_VALUE)}`;
  }
  stack.add(value);
  try {
    const jsonValue = readPluginCacheJsonValue(value);
    if (jsonValue.ok && jsonValue.value !== value) {
      return `toJSON:${stablePluginCacheValueKey(jsonValue.value, stack)}`;
    }
    if (Array.isArray(value)) {
      const fields: string[] = [];
      for (let index = 0; index < value.length; index++) {
        try {
          fields.push(stablePluginCacheValueKey(value[index], stack));
        } catch {
          fields.push(`unreadable:${JSON.stringify(PLUGIN_CACHE_UNREADABLE_VALUE)}`);
        }
      }
      return `array:[${fields.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    let keys: string[];
    try {
      keys = Object.keys(record).toSorted();
    } catch {
      return `unreadable-object:${JSON.stringify(PLUGIN_CACHE_UNREADABLE_OBJECT)}`;
    }
    const fields: string[] = [];
    for (const key of keys) {
      try {
        fields.push(`${JSON.stringify(key)}:${stablePluginCacheValueKey(record[key], stack)}`);
      } catch {
        fields.push(
          `${JSON.stringify(key)}:unreadable:${JSON.stringify(PLUGIN_CACHE_UNREADABLE_VALUE)}`,
        );
      }
    }
    return `object:{${fields.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function readPluginCacheJsonValue(value: object): { ok: true; value: unknown } | { ok: false } {
  if (value instanceof Date) {
    return { ok: true, value: value.toJSON() };
  }
  if (value instanceof URL) {
    return { ok: true, value: value.toJSON() };
  }
  return { ok: false };
}

export function createConfigScopedPromiseLoader<T>(
  load: (config?: OpenClawConfig) => T | Promise<T>,
): ConfigScopedPromiseLoader<T> {
  let defaultPromise: Promise<T> | undefined;
  let promisesByConfig = new WeakMap<OpenClawConfig, Promise<T>>();

  const createPromise = (config?: OpenClawConfig): Promise<T> => {
    const promise = Promise.resolve().then(() => load(config));
    void promise.catch(() => {
      if (config) {
        promisesByConfig.delete(config);
      } else if (defaultPromise === promise) {
        defaultPromise = undefined;
      }
    });
    return promise;
  };

  return {
    async load(config?: OpenClawConfig): Promise<T> {
      if (!config) {
        defaultPromise ??= createPromise();
        return await defaultPromise;
      }
      const cached = promisesByConfig.get(config);
      if (cached) {
        return await cached;
      }
      const promise = createPromise(config);
      promisesByConfig.set(config, promise);
      return await promise;
    },
    clear(): void {
      defaultPromise = undefined;
      promisesByConfig = new WeakMap<OpenClawConfig, Promise<T>>();
    },
  };
}

function normalizeMaxEntries(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
