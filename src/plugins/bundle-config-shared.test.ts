import { describe, expect, it } from "vitest";
import { inspectBundleServerRuntimeSupport } from "./bundle-config-shared.js";

describe("inspectBundleServerRuntimeSupport", () => {
  it("keeps readable synthetic bundle servers when sibling entries are unreadable", () => {
    const servers: Record<string, Record<string, unknown>> = {
      mockplugin: {
        command: "node",
      },
    };
    Object.defineProperty(servers, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin server entry is unreadable");
      },
    });

    expect(
      inspectBundleServerRuntimeSupport({
        loaded: { config: {}, diagnostics: ["existing diagnostic"] },
        resolveServers: () => servers,
      }),
    ).toStrictEqual({
      hasSupportedServer: true,
      supportedServerNames: ["mockplugin"],
      unsupportedServerNames: ["fuzzplugin"],
      diagnostics: ["existing diagnostic", "unable to inspect bundle server fuzzplugin"],
    });
  });

  it("reports unreadable synthetic bundle server commands as unsupported", () => {
    const unreadableServer: Record<string, unknown> = {};
    Object.defineProperty(unreadableServer, "command", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin command is unreadable");
      },
    });

    expect(
      inspectBundleServerRuntimeSupport({
        loaded: { config: {}, diagnostics: [] },
        resolveServers: () => ({
          mockplugin: { command: "node" },
          fuzzplugin: unreadableServer,
        }),
      }),
    ).toStrictEqual({
      hasSupportedServer: true,
      supportedServerNames: ["mockplugin"],
      unsupportedServerNames: ["fuzzplugin"],
      diagnostics: ["unable to inspect bundle server fuzzplugin command"],
    });
  });
});
