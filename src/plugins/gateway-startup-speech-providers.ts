import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveEffectiveTtsConfig } from "../tts/tts-config.js";

const TTS_PROVIDER_CONFIG_RESERVED_KEYS = new Set([
  "auto",
  "enabled",
  "maxTextLength",
  "mode",
  "modelOverrides",
  "persona",
  "personas",
  "prefsPath",
  "provider",
  "providers",
  "summaryModel",
  "timeoutMs",
]);

function readRecordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
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
    let hasEntry = true;
    try {
      hasEntry = index in value;
    } catch {
      hasEntry = true;
    }
    if (!hasEntry) {
      continue;
    }
    try {
      entries.push(value[index]);
    } catch {
      // Skip unreadable startup config entries; readable siblings can still load providers.
    }
  }
  return entries;
}

function copyRecordEntries(value: unknown): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[] = [];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      // Skip unreadable startup config entries; readable siblings can still load providers.
    }
  }
  return entries;
}

function isConfigActivationValueEnabled(value: unknown): boolean {
  if (value === false) {
    return false;
  }
  if (isRecord(value) && readRecordValue(value, "enabled") === false) {
    return false;
  }
  return true;
}

export function normalizeConfiguredSpeechProviderIdForStartup(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function resolveProviderConfigActivation(
  ttsConfig: Record<string, unknown>,
  providerId: string,
): boolean | undefined {
  let fromProviders: boolean | undefined;
  const providers = readRecordValue(ttsConfig, "providers");
  if (isRecord(providers)) {
    for (const [key, providerConfig] of copyRecordEntries(providers)) {
      if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) {
        fromProviders = isConfigActivationValueEnabled(providerConfig);
      }
    }
  }
  if (fromProviders !== undefined) {
    return fromProviders;
  }

  for (const [key, providerConfig] of copyRecordEntries(ttsConfig)) {
    if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord(providerConfig)) {
      continue;
    }
    if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) {
      return isConfigActivationValueEnabled(providerConfig);
    }
  }
  return undefined;
}

function addProviderIfEnabled(
  target: Set<string>,
  ttsConfig: Record<string, unknown>,
  providerId: unknown,
): void {
  const normalized = normalizeConfiguredSpeechProviderIdForStartup(providerId);
  if (!normalized) {
    return;
  }
  if (resolveProviderConfigActivation(ttsConfig, normalized) !== false) {
    target.add(normalized);
  }
}

function findActivePersona(
  ttsConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const personaId = normalizeOptionalLowercaseString(
    typeof readRecordValue(ttsConfig, "persona") === "string"
      ? readRecordValue(ttsConfig, "persona")
      : undefined,
  );
  const personas = readRecordValue(ttsConfig, "personas");
  if (!personaId || !isRecord(personas)) {
    return undefined;
  }
  for (const [id, persona] of copyRecordEntries(personas)) {
    if (normalizeOptionalLowercaseString(id) === personaId && isRecord(persona)) {
      return persona;
    }
  }
  return undefined;
}

function addActivePersonaProvider(target: Set<string>, ttsConfig: Record<string, unknown>): void {
  const persona = findActivePersona(ttsConfig);
  if (!persona) {
    return;
  }
  const provider = normalizeConfiguredSpeechProviderIdForStartup(
    readRecordValue(persona, "provider"),
  );
  if (!provider) {
    return;
  }
  const rootActivation = resolveProviderConfigActivation(ttsConfig, provider);
  const personaActivation = resolveProviderConfigActivation(persona, provider);
  if ((personaActivation ?? rootActivation) !== false) {
    target.add(provider);
  }
}

function addConfiguredTtsProviderIds(target: Set<string>, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  addProviderIfEnabled(target, value, readRecordValue(value, "provider"));
  addActivePersonaProvider(target, value);

  const providers = readRecordValue(value, "providers");
  if (isRecord(providers)) {
    for (const [providerId, providerConfig] of copyRecordEntries(providers)) {
      if (isConfigActivationValueEnabled(providerConfig)) {
        addProviderIfEnabled(target, value, providerId);
      }
    }
  }
  for (const [key, providerConfig] of copyRecordEntries(value)) {
    if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord(providerConfig)) {
      continue;
    }
    if (isConfigActivationValueEnabled(providerConfig)) {
      addProviderIfEnabled(target, value, key);
    }
  }
}

export function collectConfiguredSpeechProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const configured = new Set<string>();
  addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config));

  const agents = readRecordValue(config, "agents");
  const agentList = isRecord(agents) ? readRecordValue(agents, "list") : undefined;
  if (isRecord(agents) && Array.isArray(agentList)) {
    for (const agent of copyArrayEntries(agentList)) {
      if (isRecord(agent)) {
        const agentId = readRecordValue(agent, "id");
        if (typeof agentId === "string") {
          addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, { agentId }));
        } else {
          addConfiguredTtsProviderIds(configured, readRecordValue(agent, "tts"));
        }
      }
    }
  }

  const channels = readRecordValue(config, "channels");
  if (isRecord(channels)) {
    for (const [channelId, channelConfig] of copyRecordEntries(channels)) {
      if (!isRecord(channelConfig)) {
        continue;
      }
      addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, { channelId }));
      const channelVoice = readRecordValue(channelConfig, "voice");
      if (isRecord(channelVoice)) {
        addConfiguredTtsProviderIds(configured, readRecordValue(channelVoice, "tts"));
      }
      const accounts = readRecordValue(channelConfig, "accounts");
      if (isRecord(accounts)) {
        for (const [accountId, accountConfig] of copyRecordEntries(accounts)) {
          if (!isRecord(accountConfig)) {
            continue;
          }
          addConfiguredTtsProviderIds(
            configured,
            resolveEffectiveTtsConfig(config, { channelId, accountId }),
          );
          const accountVoice = readRecordValue(accountConfig, "voice");
          if (isRecord(accountVoice)) {
            addConfiguredTtsProviderIds(configured, readRecordValue(accountVoice, "tts"));
          }
        }
      }
    }
  }

  const plugins = readRecordValue(config, "plugins");
  const pluginEntries = isRecord(plugins) ? readRecordValue(plugins, "entries") : undefined;
  if (isRecord(pluginEntries)) {
    for (const [, entry] of copyRecordEntries(pluginEntries)) {
      const pluginConfig = readRecordValue(entry, "config");
      if (isRecord(entry) && isRecord(pluginConfig)) {
        addConfiguredTtsProviderIds(configured, readRecordValue(pluginConfig, "tts"));
      }
    }
  }

  return configured;
}
