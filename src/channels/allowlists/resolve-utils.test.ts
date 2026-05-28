import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "./resolve-utils.js";

describe("buildAllowlistResolutionSummary", () => {
  it("returns mapping, additions, and unresolved (including missing ids)", () => {
    const resolvedUsers = [
      { input: "a", resolved: true, id: "1" },
      { input: "b", resolved: false },
      { input: "c", resolved: true },
    ];
    const result = buildAllowlistResolutionSummary(resolvedUsers);
    expect(result.mapping).toEqual(["a→1"]);
    expect(result.additions).toEqual(["1"]);
    expect(result.unresolved).toEqual(["b", "c"]);
  });

  it("supports custom resolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: true, id: "1", note: "x" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatResolved: (entry) =>
        `${entry.input}→${entry.id}${(entry as { note?: string }).note ? " (note)" : ""}`,
    });
    expect(result.mapping).toEqual(["a→1 (note)"]);
  });

  it("supports custom unresolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: false, note: "missing" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatUnresolved: (entry) =>
        `${entry.input}${(entry as { note?: string }).note ? " (missing)" : ""}`,
    });
    expect(result.unresolved).toEqual(["a (missing)"]);
  });

  it("skips unreadable synthetic plugin resolution entries", () => {
    const resolvedUsers = Array.from({ length: 2 }) as Array<{
      input: string;
      resolved: boolean;
      id?: string;
    }>;
    Object.defineProperty(resolvedUsers, 0, {
      enumerable: true,
      get() {
        throw new Error("unreadable resolution");
      },
    });
    resolvedUsers[1] = { input: "mockplugin", resolved: true, id: "111" };

    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatResolved() {
        throw new Error("formatter failed");
      },
    });

    expect(result.mapping).toEqual(["mockplugin→111"]);
    expect(result.additions).toEqual(["111"]);
    expect(result.resolvedMap.get("mockplugin")).toBe(resolvedUsers[1]);
  });
});

describe("addAllowlistUserEntriesFromConfigEntry", () => {
  it("adds trimmed users and skips '*' and blanks", () => {
    const target = new Set<string>();
    addAllowlistUserEntriesFromConfigEntry(target, { users: ["  a  ", "*", "", "b"] });
    expect(Array.from(target).toSorted()).toEqual(["a", "b"]);
  });

  it("ignores non-objects", () => {
    const target = new Set<string>(["a"]);
    addAllowlistUserEntriesFromConfigEntry(target, null);
    expect(Array.from(target)).toEqual(["a"]);
  });

  it("ignores unreadable synthetic plugin user lists", () => {
    const target = new Set<string>(["owner"]);
    const entry = {};
    Object.defineProperty(entry, "users", {
      enumerable: true,
      get() {
        throw new Error("users unavailable");
      },
    });

    addAllowlistUserEntriesFromConfigEntry(target, entry);

    expect(Array.from(target)).toEqual(["owner"]);
  });

  it("keeps readable synthetic plugin users after unreadable array entries", () => {
    const target = new Set<string>();
    const users = Array.from({ length: 2 }) as Array<string | number>;
    Object.defineProperty(users, 0, {
      enumerable: true,
      get() {
        throw new Error("unreadable user");
      },
    });
    users[1] = " mockplugin ";

    addAllowlistUserEntriesFromConfigEntry(target, { users });

    expect(Array.from(target)).toEqual(["mockplugin"]);
  });
});

describe("canonicalizeAllowlistWithResolvedIds", () => {
  it("replaces resolved names with ids and keeps unresolved entries", () => {
    const resolvedMap = new Map([
      ["Alice#1234", { input: "Alice#1234", resolved: true, id: "111" }],
      ["bob", { input: "bob", resolved: false }],
    ]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["Alice#1234", "bob", "222", "*"],
      resolvedMap,
    });
    expect(result).toEqual(["111", "bob", "222", "*"]);
  });

  it("deduplicates ids after canonicalization", () => {
    const resolvedMap = new Map([["alice", { input: "alice", resolved: true, id: "111" }]]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["alice", "111", "alice"],
      resolvedMap,
    });
    expect(result).toEqual(["111"]);
  });

  it("keeps readable synthetic plugin allowlist entries after unreadable array entries", () => {
    const resolvedMap = new Map([
      ["mockplugin", { input: "mockplugin", resolved: true, id: "111" }],
    ]);
    const existing = Array.from({ length: 2 }) as Array<string | number>;
    Object.defineProperty(existing, 0, {
      enumerable: true,
      get() {
        throw new Error("unreadable allowlist");
      },
    });
    existing[1] = "mockplugin";

    const result = canonicalizeAllowlistWithResolvedIds({ existing, resolvedMap });

    expect(result).toEqual(["111"]);
  });
});

describe("patchAllowlistUsersInConfigEntries", () => {
  it("supports canonicalization strategy for nested users", () => {
    const entries = {
      alpha: { users: ["Alice", "111", "Bob"] },
      beta: { users: ["*"] },
    };
    const resolvedMap = new Map([
      ["Alice", { input: "Alice", resolved: true, id: "111" }],
      ["Bob", { input: "Bob", resolved: false }],
    ]);
    const patched = patchAllowlistUsersInConfigEntries({
      entries,
      resolvedMap,
      strategy: "canonicalize",
    });
    expect((patched.alpha as { users: string[] }).users).toEqual(["111", "Bob"]);
    expect((patched.beta as { users: string[] }).users).toEqual(["*"]);
  });

  it("skips unreadable synthetic plugin config entries and patches readable siblings", () => {
    const entries: Record<string, unknown> = {
      mockplugin: { users: ["Alice"], enabled: true },
    };
    Object.defineProperty(entries, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("unreadable config entry");
      },
    });
    const resolvedMap = new Map([["Alice", { input: "Alice", resolved: true, id: "111" }]]);

    const patched = patchAllowlistUsersInConfigEntries({
      entries,
      resolvedMap,
      strategy: "canonicalize",
    });

    expect(Object.keys(patched)).toEqual(["mockplugin"]);
    expect((patched.mockplugin as { users: string[] }).users).toEqual(["111"]);
    expect((patched.mockplugin as { enabled: boolean }).enabled).toBe(true);
  });

  it("patches readable fields when synthetic plugin entry fields are unreadable", () => {
    const entry: Record<string, unknown> = { users: ["Alice"] };
    Object.defineProperty(entry, "note", {
      enumerable: true,
      get() {
        throw new Error("unreadable field");
      },
    });
    const resolvedMap = new Map([["Alice", { input: "Alice", resolved: true, id: "111" }]]);

    const patched = patchAllowlistUsersInConfigEntries({
      entries: { fuzzplugin: entry },
      resolvedMap,
    });

    expect((patched.fuzzplugin as { users: string[] }).users).toEqual(["Alice", "111"]);
    expect("note" in patched.fuzzplugin).toBe(false);
  });
});

describe("summarizeMapping", () => {
  it("logs sampled resolved and unresolved entries", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    summarizeMapping("demo allowlist", ["a", "b", "c", "d", "e", "f", "g"], ["x", "y"], runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      "demo allowlist resolved: a, b, c, d, e, f (+1)\ndemo allowlist unresolved: x, y",
    );
  });

  it("skips logging when both lists are empty", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    summarizeMapping("demo allowlist", [], [], runtime);

    expect(runtime.log).not.toHaveBeenCalled();
  });
});
