import {
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  mergeSsrFPolicies,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeUniqueStringEntries } from "../shared/string-normalization.js";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "./channel-contract.js";
import type { OpenClawConfig } from "./config-runtime.js";

export { isPrivateIpAddress, mergeSsrFPolicies };
export type { SsrFPolicy };

export type PrivateNetworkOptInInput =
  | boolean
  | null
  | undefined
  | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
  | {
      dangerouslyAllowPrivateNetwork?: boolean | null;
      /** @deprecated Compatibility alias; prefer dangerouslyAllowPrivateNetwork. */
      allowPrivateNetwork?: boolean | null;
      network?:
        | Pick<SsrFPolicy, "allowPrivateNetwork" | "dangerouslyAllowPrivateNetwork">
        | null
        | undefined;
    };

function readRecordField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function hasOwnRecordField(record: Record<string, unknown>, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    return false;
  }
}

function readRecordEntries(record: Record<string, unknown>): Array<[string, unknown]> | undefined {
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    return undefined;
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, record[key]]);
    } catch {
      continue;
    }
  }
  return entries;
}

function copyRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = readRecordEntries(record);
  return entries ? Object.fromEntries(entries) : undefined;
}

export function isPrivateNetworkOptInEnabled(input: PrivateNetworkOptInInput): boolean {
  if (input === true) {
    return true;
  }
  const record = asNullableRecord(input);
  if (!record) {
    return false;
  }
  const network = asNullableRecord(readRecordField(record, "network"));
  const networkAllowsPrivateAccess = network
    ? readRecordField(network, "allowPrivateNetwork") === true ||
      readRecordField(network, "dangerouslyAllowPrivateNetwork") === true
    : false;
  return (
    readRecordField(record, "allowPrivateNetwork") === true ||
    readRecordField(record, "dangerouslyAllowPrivateNetwork") === true ||
    networkAllowsPrivateAccess
  );
}

export function ssrfPolicyFromPrivateNetworkOptIn(
  input: PrivateNetworkOptInInput,
): SsrFPolicy | undefined {
  return isPrivateNetworkOptInEnabled(input) ? { allowPrivateNetwork: true } : undefined;
}

export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(
  dangerouslyAllowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromPrivateNetworkOptIn(dangerouslyAllowPrivateNetwork);
}

export function hasLegacyFlatAllowPrivateNetworkAlias(value: unknown): boolean {
  const entry = asNullableRecord(value);
  return Boolean(entry && hasOwnRecordField(entry, "allowPrivateNetwork"));
}

export function migrateLegacyFlatAllowPrivateNetworkAlias(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  if (!hasLegacyFlatAllowPrivateNetworkAlias(params.entry)) {
    return { entry: params.entry, changed: false };
  }

  const legacyAllowPrivateNetwork = readRecordField(params.entry, "allowPrivateNetwork");
  const currentNetworkRecord = asNullableRecord(readRecordField(params.entry, "network"));
  const currentNetwork = currentNetworkRecord ? copyRecord(currentNetworkRecord) : {};
  const nextEntry = copyRecord(params.entry);
  if (!currentNetwork || !nextEntry) {
    return { entry: params.entry, changed: false };
  }
  const currentDangerousAllowPrivateNetwork = readRecordField(
    currentNetwork,
    "dangerouslyAllowPrivateNetwork",
  );

  let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
  if (typeof currentDangerousAllowPrivateNetwork === "boolean") {
    // The canonical key wins when both shapes are present.
    resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
  } else if (typeof legacyAllowPrivateNetwork === "boolean") {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  } else if (currentDangerousAllowPrivateNetwork === undefined) {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  }

  delete currentNetwork.dangerouslyAllowPrivateNetwork;
  if (resolvedDangerousAllowPrivateNetwork !== undefined) {
    currentNetwork.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
  }

  delete nextEntry.allowPrivateNetwork;
  if (Object.keys(currentNetwork).length > 0) {
    nextEntry.network = currentNetwork;
  } else {
    delete nextEntry.network;
  }

  params.changes.push(
    `Moved ${params.pathPrefix}.allowPrivateNetwork → ${params.pathPrefix}.network.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
  );
  return { entry: nextEntry, changed: true };
}

function hasLegacyAllowPrivateNetworkInAccounts(value: unknown): boolean {
  const accounts = asNullableRecord(value);
  const entries = accounts ? readRecordEntries(accounts) : undefined;
  return Boolean(
    entries &&
    entries.some(([, account]) =>
      hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(account) ?? {}),
    ),
  );
}

export function createLegacyPrivateNetworkDoctorContract(params: { channelKey: string }): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const pathPrefix = `channels.${params.channelKey}`;
  return {
    legacyConfigRules: [
      {
        path: ["channels", params.channelKey],
        message: `${pathPrefix}.allowPrivateNetwork is legacy; use ${pathPrefix}.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(value) ?? {}),
      },
      {
        path: ["channels", params.channelKey, "accounts"],
        message: `${pathPrefix}.accounts.<id>.allowPrivateNetwork is legacy; use ${pathPrefix}.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: hasLegacyAllowPrivateNetworkInAccounts,
      },
    ],
    normalizeCompatibilityConfig: ({ cfg }) => {
      const channels = asNullableRecord(readRecordField(cfg, "channels"));
      const channelEntry = asNullableRecord(
        channels ? readRecordField(channels, params.channelKey) : undefined,
      );
      if (!channelEntry) {
        return { config: cfg, changes: [] };
      }

      const changes: string[] = [];
      let updatedChannel = channelEntry;
      let changed = false;

      const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
        entry: updatedChannel,
        pathPrefix,
        changes,
      });
      updatedChannel = topLevel.entry;
      changed = changed || topLevel.changed;

      const accounts = asNullableRecord(readRecordField(updatedChannel, "accounts"));
      if (accounts) {
        let accountsChanged = false;
        const nextAccounts = copyRecord(accounts);
        const accountEntries = readRecordEntries(accounts);
        if (!nextAccounts || !accountEntries) {
          return { config: cfg, changes: [] };
        }
        for (const [accountId, accountValue] of accountEntries) {
          const account = asNullableRecord(accountValue);
          if (!account) {
            continue;
          }
          const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
            entry: account,
            pathPrefix: `${pathPrefix}.accounts.${accountId}`,
            changes,
          });
          if (!migrated.changed) {
            continue;
          }
          nextAccounts[accountId] = migrated.entry;
          accountsChanged = true;
        }
        if (accountsChanged) {
          const nextChannel = copyRecord(updatedChannel);
          if (!nextChannel) {
            return { config: cfg, changes: [] };
          }
          updatedChannel = { ...nextChannel, accounts: nextAccounts };
          changed = true;
        }
      }

      if (!changed) {
        return { config: cfg, changes: [] };
      }

      const nextConfig = copyRecord(cfg);
      const nextChannels = channels ? copyRecord(channels) : {};
      if (!nextConfig || !nextChannels) {
        return { config: cfg, changes: [] };
      }
      nextChannels[params.channelKey] = updatedChannel;
      nextConfig.channels = nextChannels as OpenClawConfig["channels"];
      return { config: nextConfig as OpenClawConfig, changes };
    },
  };
}

export function ssrfPolicyFromAllowPrivateNetwork(
  allowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);
}

export async function assertHttpUrlTargetsPrivateNetwork(
  url: string,
  params: {
    dangerouslyAllowPrivateNetwork?: boolean | null;
    allowPrivateNetwork?: boolean | null;
    lookupFn?: LookupFn;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") {
    return;
  }

  const errorMessage =
    params.errorMessage ?? "HTTP URL must target a trusted private/internal host";
  const { hostname } = parsed;
  if (!hostname) {
    throw new Error(errorMessage);
  }

  // Literal loopback/private hosts can stay local without DNS.
  if (isBlockedHostnameOrIp(hostname)) {
    return;
  }

  const allowPrivateNetwork =
    typeof params.dangerouslyAllowPrivateNetwork === "boolean"
      ? params.dangerouslyAllowPrivateNetwork
      : params.allowPrivateNetwork;

  if (allowPrivateNetwork !== true) {
    throw new Error(errorMessage);
  }

  // Private-network opt-in is for trusted private/internal targets, not a
  // blanket exemption for cleartext public internet hosts.
  const pinned = await resolvePinnedHostnameWithPolicy(hostname, {
    lookupFn: params.lookupFn,
    policy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
  });
  if (!pinned.addresses.every((address) => isPrivateIpAddress(address))) {
    throw new Error(errorMessage);
  }
}

function normalizeHostnameSuffix(value: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(value);
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*" || trimmed === "*.") {
    return "*";
  }
  const withoutWildcard = trimmed.replace(/^\*\.?/, "");
  const withoutLeadingDot = withoutWildcard.replace(/^\.+/, "");
  return withoutLeadingDot.replace(/\.+$/, "");
}

function isHostnameAllowedBySuffixAllowlist(
  hostname: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.includes("*")) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}

/** Normalize suffix-style host allowlists into lowercase canonical entries with wildcard collapse. */
export function normalizeHostnameSuffixAllowlist(
  input?: readonly string[],
  defaults?: readonly string[],
): string[] {
  const source = input && input.length > 0 ? input : defaults;
  if (!source || source.length === 0) {
    return [];
  }
  const normalized = normalizeUniqueStringEntries(source.map(normalizeHostnameSuffix));
  if (normalized.includes("*")) {
    return ["*"];
  }
  return normalized;
}

/** Check whether a URL is HTTPS and its hostname matches the normalized suffix allowlist. */
export function isHttpsUrlAllowedByHostnameSuffixAllowlist(
  url: string,
  allowlist: readonly string[],
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }
    return isHostnameAllowedBySuffixAllowlist(parsed.hostname, allowlist);
  } catch {
    return false;
  }
}

/**
 * Converts suffix-style host allowlists (for example "example.com") into SSRF
 * hostname allowlist patterns used by the shared fetch guard.
 *
 * Suffix semantics:
 * - "example.com" allows "example.com" and "*.example.com"
 * - "*" disables hostname allowlist restrictions
 */
export function buildHostnameAllowlistPolicyFromSuffixAllowlist(
  allowHosts?: readonly string[],
): SsrFPolicy | undefined {
  const normalizedAllowHosts = normalizeHostnameSuffixAllowlist(allowHosts);
  if (normalizedAllowHosts.length === 0) {
    return undefined;
  }
  const patterns = new Set<string>();
  for (const normalized of normalizedAllowHosts) {
    if (normalized === "*") {
      return undefined;
    }
    patterns.add(normalized);
    patterns.add(`*.${normalized}`);
  }

  if (patterns.size === 0) {
    return undefined;
  }
  return { hostnameAllowlist: Array.from(patterns) };
}
