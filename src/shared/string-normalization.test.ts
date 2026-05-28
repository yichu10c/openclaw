import { describe, expect, it } from "vitest";
import {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeSortedUniqueStringEntries,
  normalizeSortedUniqueTrimmedStringList,
  normalizeStringEntries,
  normalizeStringEntriesLower,
  normalizeTrimmedStringList,
  normalizeUniqueSingleOrTrimmedStringList,
  normalizeUniqueStringEntries,
  normalizeUniqueStringEntriesLower,
  normalizeUniqueTrimmedStringList,
  sortUniqueStrings,
  uniqueStrings,
} from "./string-normalization.js";

describe("shared/string-normalization", () => {
  it("normalizes mixed allow-list entries", () => {
    expect(normalizeStringEntries([" a ", 42, "", "  ", "z"])).toEqual(["a", "42", "z"]);
    expect(normalizeStringEntries([" ok ", null, { toString: () => " obj " }])).toEqual([
      "ok",
      "null",
      "obj",
    ]);
    expect(normalizeStringEntries(undefined)).toStrictEqual([]);
  });

  it("copies synthetic plugin string arrays without trusting array methods", () => {
    const methodHostile = new Proxy([" owner ", "", "admin"], {
      get(target, key, receiver) {
        if (key === "map" || key === "flatMap" || key === Symbol.iterator) {
          throw new Error("fuzzplugin string array method failed");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const entryHostile = ["keep", "drop", "later"];
    Object.defineProperty(entryHostile, "1", {
      get() {
        throw new Error("mockplugin string entry failed");
      },
    });

    expect(normalizeStringEntries(methodHostile)).toEqual(["owner", "admin"]);
    expect(normalizeTrimmedStringList(methodHostile)).toEqual(["owner", "admin"]);
    expect(normalizeStringEntries(entryHostile)).toEqual(["keep", "later"]);
  });

  it("treats unreadable synthetic plugin string lists as absent", () => {
    const lengthHostile = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") {
          throw new Error("fuzzplugin string array length failed");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const stringHostile = {
      toString() {
        throw new Error("mockplugin string coercion failed");
      },
    };

    expect(normalizeStringEntries(lengthHostile)).toStrictEqual([]);
    expect(normalizeStringEntries([stringHostile, " ok "])).toEqual(["ok"]);
  });

  it("normalizes mixed allow-list entries to lowercase", () => {
    expect(normalizeStringEntriesLower([" A ", "MiXeD", 7])).toEqual(["a", "mixed", "7"]);
  });

  it("sorts unique string values", () => {
    expect(sortUniqueStrings(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("deduplicates string values while preserving first-seen order", () => {
    expect(uniqueStrings(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("normalizes unique string entries", () => {
    expect(normalizeUniqueStringEntries([" b ", "a", "b", "", 4, "a"])).toEqual(["b", "a", "4"]);
  });

  it("keeps readable unique entries from hostile synthetic plugin iterables", () => {
    let index = 0;
    const iterable = {
      [Symbol.iterator]() {
        return {
          next() {
            index += 1;
            if (index === 1) {
              return { value: " owner ", done: false };
            }
            throw new Error("fuzzplugin string iterator failed");
          },
        };
      },
    };

    expect(normalizeUniqueStringEntries(iterable)).toEqual(["owner"]);
  });

  it("normalizes unique lowercase string entries", () => {
    expect(normalizeUniqueStringEntriesLower([" A ", "a", "MiXeD", "", 7])).toEqual([
      "a",
      "mixed",
      "7",
    ]);
  });

  it("normalizes sorted unique string entries", () => {
    expect(normalizeSortedUniqueStringEntries([" b ", "a", "b", "", 4])).toEqual(["4", "a", "b"]);
  });

  it("normalizes unique trimmed string lists", () => {
    expect(normalizeUniqueTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual(["b", "a"]);
    expect(normalizeUniqueTrimmedStringList("b")).toEqual([]);
  });

  it("normalizes sorted unique trimmed string lists", () => {
    expect(normalizeSortedUniqueTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual(["a", "b"]);
    expect(normalizeSortedUniqueTrimmedStringList(["z", 1, " a "] as unknown[])).toEqual([
      "a",
      "z",
    ]);
  });

  it("normalizes unique single-or-list string values", () => {
    expect(normalizeUniqueSingleOrTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual([
      "b",
      "a",
    ]);
    expect(normalizeUniqueSingleOrTrimmedStringList(" b ")).toEqual(["b"]);
  });

  it("normalizes slug-like labels while preserving supported symbols", () => {
    expect(normalizeHyphenSlug("  Team Room  ")).toBe("team-room");
    expect(normalizeHyphenSlug(" #My_Channel + Alerts ")).toBe("#my_channel-+-alerts");
    expect(normalizeHyphenSlug("..foo---bar..")).toBe("foo-bar");
    expect(normalizeHyphenSlug(undefined)).toBe("");
    expect(normalizeHyphenSlug(null)).toBe("");
  });

  it("collapses repeated separators and trims leading/trailing punctuation", () => {
    expect(normalizeHyphenSlug("  ...Hello   /  World---  ")).toBe("hello-world");
    expect(normalizeHyphenSlug(" ###Team@@@Room### ")).toBe("###team@@@room###");
  });

  it("normalizes @/# prefixed slugs used by channel allowlists", () => {
    expect(normalizeAtHashSlug(" #My_Channel + Alerts ")).toBe("my-channel-alerts");
    expect(normalizeAtHashSlug("@@Room___Name")).toBe("room-name");
    expect(normalizeAtHashSlug(undefined)).toBe("");
    expect(normalizeAtHashSlug(null)).toBe("");
  });

  it("strips repeated prefixes and collapses separator-only results", () => {
    expect(normalizeAtHashSlug("###__Room  Name__")).toBe("room-name");
    expect(normalizeAtHashSlug("@@@___")).toBe("");
  });

  it.each([
    ["技术讨论组", "技术讨论组"],
    ["  AI 助手群  ", "ai-助手群"],
    ["友達グループ", "友達グループ"],
    ["개발자 모임", "개발자-모임"],
    ["Team 技术讨论", "team-技术讨论"],
    ["#OpenClaw中文群", "#openclaw中文群"],
    ["Команда разработки", "команда-разработки"],
    ["فريق التطوير", "فريق-التطوير"],
  ])("preserves Unicode letters in normalizeHyphenSlug: %s", (input, expected) => {
    expect(normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    ["Cafe\u0301 Team", "café-team"],
    ["हिन्दी चर्चा", "हिन्दी-चर्चा"],
    ["ห้อง แช็ต", "ห้อง-แช็ต"],
  ])("preserves combining marks in normalizeHyphenSlug: %s", (input, expected) => {
    expect(normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    ["#技术频道", "技术频道"],
    ["@中文群组", "中文群组"],
    ["#日本語チャンネル", "日本語チャンネル"],
    ["#한국어채널", "한국어채널"],
    ["#Команда разработки", "команда-разработки"],
    ["@فريق التطوير", "فريق-التطوير"],
    ["#OpenClaw中文群", "openclaw中文群"],
  ])("preserves Unicode letters in normalizeAtHashSlug: %s", (input, expected) => {
    expect(normalizeAtHashSlug(input)).toBe(expected);
  });

  it.each([
    ["#Cafe\u0301_Team", "café-team"],
    ["@हिन्दी चर्चा", "हिन्दी-चर्चा"],
    ["#ห้อง แช็ต", "ห้อง-แช็ต"],
  ])("preserves combining marks in normalizeAtHashSlug: %s", (input, expected) => {
    expect(normalizeAtHashSlug(input)).toBe(expected);
  });
});
