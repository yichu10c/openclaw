import type {
  ExecApprovalForwardingConfig,
  ExecApprovalForwardingMode,
} from "../config/types.approvals.js";
import { doesApprovalRequestMatchChannelAccount } from "../infra/approval-request-account-binding.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
import type { ExecApprovalSessionTarget } from "../infra/exec-approval-session-target.js";
import { resolveApprovalRequestOriginTarget } from "../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { ChannelApprovalCapability, ChannelOutboundPayloadHint } from "./channel-contract.js";
import { channelRouteTargetsMatchExact } from "./channel-route.js";
import type { OpenClawConfig } from "./config-runtime.js";
import type { ReplyPayload } from "./reply-payload.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalKind = "exec" | "plugin";
type DeliverySuppressionInput = Parameters<
  NonNullable<
    NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
  >
>[0];
type NativeApprovalForwardTarget = DeliverySuppressionInput["target"];
type LocalNativeExecApprovalConfig = {
  enabled?: boolean | "auto";
  mode?: string | null;
  agentFilter?: string[];
  sessionFilter?: string[];
};
type ChannelApprovalForwardTarget = DeliverySuppressionInput["target"];

type ApprovalResolverParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ApprovalKind;
  request: ApprovalRequest;
};

type ChannelApprovalForwardingEvaluatorParams = {
  channel: string;
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  hasMatchingTarget: (params: {
    cfg: OpenClawConfig;
    config: ExecApprovalForwardingConfig;
    accountId?: string | null;
    target?: ChannelApprovalForwardTarget;
  }) => boolean;
  hasOriginOrSessionTarget: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    request: ApprovalRequest;
  }) => boolean;
};

export type ChannelApprovalForwardingEligibilityParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  request: ApprovalRequest;
};

export type ChannelApprovalPotentialRouteParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ApprovalKind;
  nativeSessionOnly?: boolean;
};

export type ChannelApprovalExplicitTargetEligibilityParams =
  ChannelApprovalForwardingEligibilityParams & {
    target: ChannelApprovalForwardTarget;
  };

type NativeApprovalTargetNormalizer<TTarget> = (
  target: TTarget,
  request: ApprovalRequest,
) => TTarget | null | undefined;

type NativeApprovalForwardingFallbackSuppressorParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  normalizeForwardTarget: (target: NativeApprovalForwardTarget) => TTarget | null;
  resolveAccountId?: (params: {
    forwardingTarget: TTarget;
    target: NativeApprovalForwardTarget;
    request: ApprovalRequest;
  }) => string | null | undefined;
  resolveApprovalKind?: (params: {
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }) => ApprovalKind;
  isSessionRouteEligible: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => boolean;
  isExplicitTargetEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
    target: NativeApprovalForwardTarget;
  }) => boolean;
  resolveForwardingTargetForMatch?: (params: {
    forwardingTarget: TTarget;
    accountId?: string | null;
    target: NativeApprovalForwardTarget;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => TTarget | null;
  resolveOriginTarget: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => TTarget | null;
  resolveApproverDmTargets: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind: ApprovalKind;
    request: ApprovalRequest;
  }) => readonly TTarget[];
  targetsMatch?: (left: TTarget, right: TTarget) => boolean;
};

type NativeOriginResolverParams<TTarget extends NativeApprovalTarget> = {
  channel: string;
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  targetsMatch?: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

type CustomOriginResolverParams<TTarget> = {
  channel: string;
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveTurnSourceTarget: (request: ApprovalRequest) => TTarget | null;
  resolveSessionTarget: (
    sessionTarget: ExecApprovalSessionTarget,
    request: ApprovalRequest,
  ) => TTarget | null;
  normalizeTarget?: NativeApprovalTargetNormalizer<TTarget>;
  normalizeTargetForMatch?: NativeApprovalTargetNormalizer<TTarget>;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequest) => TTarget | null;
};

export type NativeApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const MAX_NATIVE_APPROVAL_LIST_ENTRIES = 10_000;

function readRecordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const result = tryReadRecordValue(record, key);
  return result.readable ? result.value : undefined;
}

function tryReadRecordValue(
  record: object,
  key: string,
): { readable: true; value: unknown } | { readable: false } {
  try {
    return { readable: true, value: (record as Record<string, unknown>)[key] };
  } catch {
    return { readable: false };
  }
}

function hasRecordKey(record: unknown, key: string): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }
  try {
    return key in record;
  } catch {
    return false;
  }
}

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const safeLength = Math.min(Math.max(0, length), MAX_NATIVE_APPROVAL_LIST_ENTRIES);
  const entries: unknown[] = [];
  for (let index = 0; index < safeLength; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      entries.push(undefined);
    }
  }
  return entries;
}

function callOr<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function readNativeApprovalTarget(value: unknown): NativeApprovalTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const to = tryReadRecordValue(value, "to");
  if (!to.readable || typeof to.value !== "string") {
    return undefined;
  }
  const accountId = tryReadRecordValue(value, "accountId");
  if (!accountId.readable) {
    return undefined;
  }
  const threadId = tryReadRecordValue(value, "threadId");
  if (!threadId.readable) {
    return undefined;
  }
  return {
    to: to.value,
    ...(typeof accountId.value === "string" || accountId.value === null
      ? { accountId: accountId.value }
      : {}),
    ...(typeof threadId.value === "string" ||
    typeof threadId.value === "number" ||
    threadId.value === null
      ? { threadId: threadId.value }
      : {}),
  };
}

export function nativeApprovalTargetsMatch(params: {
  channel?: string | null;
  left: NativeApprovalTarget;
  right: NativeApprovalTarget;
}): boolean {
  const left = readNativeApprovalTarget(params.left);
  const right = readNativeApprovalTarget(params.right);
  if (!left || !right) {
    return false;
  }
  return channelRouteTargetsMatchExact({
    left: {
      channel: params.channel,
      to: left.to,
      accountId: left.accountId,
      threadId: left.threadId,
    },
    right: {
      channel: params.channel,
      to: right.to,
      accountId: right.accountId,
      threadId: right.threadId,
    },
  });
}

export function shouldSuppressLocalNativeExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
  isTransportEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  isNativeDeliveryEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  resolveApprovalConfig?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => LocalNativeExecApprovalConfig | undefined;
  requireApprovalConfigEnabled?: boolean;
  enforceForwardingMode?: boolean;
  isSessionRouteEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => boolean;
  hasExactTargetProof?: boolean;
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean {
  if (params.hint?.kind !== "approval-pending" || params.hint.approvalKind !== "exec") {
    return false;
  }
  if (params.hint.nativeRouteActive !== true) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata || metadata.approvalKind !== "exec") {
    return false;
  }
  const isDeliveryEnabled = params.isNativeDeliveryEnabled ?? params.isTransportEnabled;
  if (!isDeliveryEnabled?.({ cfg: params.cfg, accountId: params.accountId })) {
    return false;
  }
  const config =
    params.resolveApprovalConfig?.({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    }) ?? params.cfg.approvals?.exec;
  const requireConfigEnabled =
    params.requireApprovalConfigEnabled ?? params.resolveApprovalConfig === undefined;
  if (requireConfigEnabled && !config?.enabled) {
    return false;
  }
  const enforceForwardingMode =
    params.enforceForwardingMode ?? params.resolveApprovalConfig === undefined;
  if (enforceForwardingMode) {
    const mode = config?.mode ?? "session";
    if (mode !== "session" && mode !== "both" && !params.hasExactTargetProof) {
      return false;
    }
  }
  if (
    params.isSessionRouteEligible &&
    !params.isSessionRouteEligible({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: {
      agentId: metadata.agentId,
      sessionKey: metadata.sessionKey,
    },
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
    fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey ?? true,
  });
}

function isNativeApprovalTarget(value: unknown): value is NativeApprovalTarget {
  return readNativeApprovalTarget(value) !== undefined;
}

function nativeApprovalTargetMatcher(channel: string): (left: unknown, right: unknown) => boolean {
  return (left, right) =>
    isNativeApprovalTarget(left) &&
    isNativeApprovalTarget(right) &&
    nativeApprovalTargetsMatch({ channel, left, right });
}

export function resolveApprovalKind(
  request: ApprovalRequest,
  approvalKind?: ApprovalKind,
): ApprovalKind {
  if (approvalKind) {
    return approvalKind;
  }
  return hasRecordKey(readRecordValue(request, "request"), "command") ? "exec" : "plugin";
}

function resolveApprovalForwardingConfig(params: {
  cfg: OpenClawConfig;
  approvalKind: ApprovalKind;
}): ExecApprovalForwardingConfig | undefined {
  return params.approvalKind === "plugin"
    ? params.cfg.approvals?.plugin
    : params.cfg.approvals?.exec;
}

function normalizeApprovalForwardingMode(
  mode: ExecApprovalForwardingConfig["mode"] | undefined,
): ExecApprovalForwardingMode {
  return mode ?? "session";
}

function approvalModeIncludesSession(mode: ExecApprovalForwardingMode): boolean {
  return mode === "session" || mode === "both";
}

function approvalModeIncludesTargets(mode: ExecApprovalForwardingMode): boolean {
  return mode === "targets" || mode === "both";
}

function matchesForwardingFilters(params: {
  config: ExecApprovalForwardingConfig;
  request: ApprovalRequest;
}): boolean {
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

export function createChannelApprovalForwardingEvaluator(
  params: ChannelApprovalForwardingEvaluatorParams,
) {
  const isPotentialRoute = (input: ChannelApprovalPotentialRouteParams): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (approvalModeIncludesSession(mode)) {
      return true;
    }
    if (input.nativeSessionOnly) {
      return false;
    }
    return (
      approvalModeIncludesTargets(mode) &&
      params.hasMatchingTarget({
        cfg: input.cfg,
        config,
        accountId: input.accountId,
      })
    );
  };

  const isSessionEligible = (input: ChannelApprovalForwardingEligibilityParams): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (!approvalModeIncludesSession(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    if (
      !doesApprovalRequestMatchChannelAccount({
        cfg: input.cfg,
        request: input.request,
        channel: params.channel,
        accountId: input.accountId,
      })
    ) {
      return false;
    }
    return params.hasOriginOrSessionTarget({
      cfg: input.cfg,
      accountId: input.accountId,
      request: input.request,
    });
  };

  const isExplicitTargetEligible = (
    input: ChannelApprovalExplicitTargetEligibilityParams,
  ): boolean => {
    if (!params.isTransportEnabled(input)) {
      return false;
    }
    const config = resolveApprovalForwardingConfig(input);
    if (!config?.enabled) {
      return false;
    }
    const mode = normalizeApprovalForwardingMode(config.mode);
    if (!approvalModeIncludesTargets(mode)) {
      return false;
    }
    if (!matchesForwardingFilters({ config, request: input.request })) {
      return false;
    }
    return params.hasMatchingTarget({
      cfg: input.cfg,
      config,
      accountId: input.accountId,
      target: input.target,
    });
  };

  const canAnyPotentiallyRoute = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }): boolean =>
    isPotentialRoute({
      ...input,
      approvalKind: "exec",
    }) ||
    isPotentialRoute({
      ...input,
      approvalKind: "plugin",
    });

  const shouldHandleRequest = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ApprovalKind;
    request: ApprovalRequest;
  }): boolean =>
    isSessionEligible({
      ...input,
      approvalKind: resolveApprovalKind(input.request, input.approvalKind),
    });

  return {
    canAnyPotentiallyRoute,
    isExplicitTargetEligible,
    isPotentialRoute,
    isSessionEligible,
    shouldHandleRequest,
  };
}

function normalizeOptionalAccountId(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

export function createNativeApprovalForwardingFallbackSuppressor<
  TTarget extends NativeApprovalTarget,
>(
  params: NativeApprovalForwardingFallbackSuppressorParams<TTarget>,
): NonNullable<
  NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
> {
  const targetsMatch =
    params.targetsMatch ??
    ((left: TTarget, right: TTarget) =>
      nativeApprovalTargetsMatch({ channel: params.channel, left, right }));

  return (input: DeliverySuppressionInput): boolean => {
    const forwardingTarget = callOr(() => params.normalizeForwardTarget(input.target), null);
    if (!forwardingTarget) {
      return false;
    }
    const accountId =
      normalizeOptionalAccountId(
        callOr(
          () =>
            params.resolveAccountId?.({
              forwardingTarget,
              target: input.target,
              request: input.request,
            }),
          undefined,
        ),
      ) ??
      normalizeOptionalAccountId(forwardingTarget.accountId) ??
      normalizeOptionalAccountId(
        readRecordValue(readRecordValue(input.request, "request"), "turnSourceAccountId") as
          | string
          | null
          | undefined,
      );
    const approvalKind =
      callOr(
        () =>
          params.resolveApprovalKind?.({
            approvalKind: input.approvalKind,
            request: input.request,
          }),
        undefined,
      ) ?? resolveApprovalKind(input.request, input.approvalKind);
    const explicitTarget = readRecordValue(input.target, "source") === "target";
    const eligible = explicitTarget
      ? callOr(
          () =>
            params.isExplicitTargetEligible?.({
              cfg: input.cfg,
              accountId,
              approvalKind,
              request: input.request,
              target: input.target,
            }) ?? false,
          false,
        )
      : callOr(
          () =>
            params.isSessionRouteEligible({
              cfg: input.cfg,
              accountId,
              approvalKind,
              request: input.request,
            }),
          false,
        );
    if (!eligible) {
      return false;
    }

    const forwardingTargetForMatch =
      callOr(
        () =>
          params.resolveForwardingTargetForMatch?.({
            forwardingTarget,
            accountId,
            target: input.target,
            approvalKind,
            request: input.request,
          }),
        undefined,
      ) ?? forwardingTarget;
    if (!forwardingTargetForMatch) {
      return false;
    }
    const originTarget = callOr(
      () =>
        params.resolveOriginTarget({
          cfg: input.cfg,
          accountId,
          approvalKind,
          request: input.request,
        }),
      null,
    );
    if (originTarget && callOr(() => targetsMatch(forwardingTargetForMatch, originTarget), false)) {
      return true;
    }
    const approverTargets = callOr(
      () =>
        params.resolveApproverDmTargets({
          cfg: input.cfg,
          accountId,
          approvalKind,
          request: input.request,
        }),
      [],
    );
    return copyArrayEntries(approverTargets).some((approverTarget) =>
      callOr(() => targetsMatch(forwardingTargetForMatch, approverTarget as TTarget), false),
    );
  };
}

function createOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null {
  return (input: ApprovalResolverParams): TTarget | null => {
    if (params.shouldHandleRequest && !callOr(() => params.shouldHandleRequest?.(input), false)) {
      return null;
    }
    const normalizeTarget = (target: TTarget | null): TTarget | null => {
      if (!target) {
        return null;
      }
      return params.normalizeTarget
        ? callOr(() => params.normalizeTarget?.(target, input.request) ?? null, null)
        : target;
    };
    const normalizeTargetForMatch = (target: TTarget): TTarget | null =>
      callOr(() => params.normalizeTargetForMatch?.(target, input.request) ?? target, null);
    return resolveApprovalRequestOriginTarget({
      cfg: input.cfg,
      request: input.request,
      channel: params.channel,
      accountId: input.accountId,
      resolveTurnSourceTarget: (request) =>
        normalizeTarget(callOr(() => params.resolveTurnSourceTarget(request), null)),
      resolveSessionTarget: (sessionTarget) =>
        normalizeTarget(
          callOr(() => params.resolveSessionTarget(sessionTarget, input.request), null),
        ),
      targetsMatch: (left, right) => {
        const normalizedLeft = normalizeTargetForMatch(left);
        const normalizedRight = normalizeTargetForMatch(right);
        return (
          Boolean(normalizedLeft && normalizedRight) &&
          callOr(
            () => params.targetsMatch(normalizedLeft as TTarget, normalizedRight as TTarget),
            false,
          )
        );
      },
      resolveFallbackTarget: params.resolveFallbackTarget
        ? (request) =>
            normalizeTarget(callOr(() => params.resolveFallbackTarget?.(request) ?? null, null))
        : undefined,
    });
  };
}

function hasCustomTargetsMatch<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): params is CustomOriginResolverParams<TTarget> {
  return typeof params.targetsMatch === "function";
}

export function createChannelNativeOriginTargetResolver<TTarget extends NativeApprovalTarget>(
  params: NativeOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => TTarget | null;
export function createChannelNativeOriginTargetResolver<TTarget>(
  params: NativeOriginResolverParams<NativeApprovalTarget> | CustomOriginResolverParams<TTarget>,
): (input: ApprovalResolverParams) => NativeApprovalTarget | TTarget | null {
  if (hasCustomTargetsMatch(params)) {
    return createOriginTargetResolver(params);
  }
  return createOriginTargetResolver({
    ...params,
    targetsMatch: nativeApprovalTargetMatcher(params.channel),
  });
}

export function createChannelApproverDmTargetResolver<
  TApprover,
  TTarget extends NativeApprovalTarget = NativeApprovalTarget,
>(params: {
  shouldHandleRequest?: (params: ApprovalResolverParams) => boolean;
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly TApprover[];
  mapApprover: (approver: TApprover, params: ApprovalResolverParams) => TTarget | null | undefined;
}) {
  return (input: ApprovalResolverParams): TTarget[] => {
    if (params.shouldHandleRequest && !callOr(() => params.shouldHandleRequest?.(input), false)) {
      return [];
    }
    const targets: TTarget[] = [];
    const approvers = callOr(
      () =>
        params.resolveApprovers({
          cfg: input.cfg,
          accountId: input.accountId,
        }),
      [],
    );
    for (const approver of copyArrayEntries(approvers)) {
      const target = callOr(() => params.mapApprover(approver as TApprover, input), null);
      if (target) {
        targets.push(target);
      }
    }
    return targets;
  };
}
