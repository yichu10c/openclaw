import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

export type AllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
};

export type CompiledAllowlist = {
  set: ReadonlySet<string>;
  wildcard: boolean;
};

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
      // Optional config allowlist entries that cannot be read are absent.
    }
  }
  return entries;
}

export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

export function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist {
  const set = new Set(
    copyArrayEntries(entries).filter(
      (entry): entry is string => typeof entry === "string" && Boolean(entry),
    ),
  );
  return {
    set,
    wildcard: set.has("*"),
  };
}

function compileSimpleAllowlist(entries: ReadonlyArray<string | number>): CompiledAllowlist {
  return compileAllowlist(
    copyArrayEntries(entries)
      .map((entry) => {
        try {
          return normalizeOptionalLowercaseString(String(entry));
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function resolveAllowlistCandidates<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (params.compiledAllowlist.set.has(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function resolveCompiledAllowlistMatch<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  if (params.compiledAllowlist.set.size === 0) {
    return { allowed: false };
  }
  if (params.compiledAllowlist.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" as TSource };
  }
  return resolveAllowlistCandidates(params);
}

export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: ReadonlyArray<string>;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compileAllowlist(params.allowList),
    candidates: params.candidates,
  });
}

export function resolveAllowlistMatchSimple(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = compileSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeLowercaseStringOrEmpty(params.senderId);
  const senderName = normalizeOptionalLowercaseString(params.senderName);
  return resolveAllowlistCandidates({
    compiledAllowlist: allowFrom,
    candidates: [
      { value: senderId, source: "id" },
      ...(params.allowNameMatching === true && senderName
        ? ([{ value: senderName, source: "name" as const }] satisfies Array<{
            value?: string;
            source: "id" | "name";
          }>)
        : []),
    ],
  });
}
