import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVitestCapabilityShimAliasMap,
  loadBundledCapabilityRuntimeRegistry,
} from "./bundled-capability-runtime.js";
import {
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

function updatePluginManifest(plugin: Pick<TempPlugin, "dir">, patch: Record<string, unknown>) {
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...raw, ...patch }, null, 2), "utf-8");
}

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/config-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/config-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/media-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/media-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/provider-onboard"]).toBe(
      aliasMap["@openclaw/plugin-sdk/provider-onboard"],
    );
    expect(aliasMap["openclaw/plugin-sdk/speech-core"]).toBe(
      aliasMap["@openclaw/plugin-sdk/speech-core"],
    );
  });
});

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("skips captured bundled tools with unreadable names while preserving healthy siblings", () => {
    const plugin = writePlugin({
      id: "fuzzplugin",
      filename: "fuzzplugin.cjs",
      body: `const fuzzTool = {
        get name() {
          throw new Error("fuzz name read failed");
        },
        description: "Fuzz tool",
        parameters: {},
        execute: async () => ({ content: [{ type: "text", text: "fuzz" }] }),
      };
      const healthyTool = {
        name: "mockplugin_status",
        description: "Mock status",
        parameters: {},
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };

      module.exports = {
        id: "fuzzplugin",
        register(api) {
          api.registerTool(fuzzTool);
          api.registerTool(healthyTool);
        },
      };`,
    });
    updatePluginManifest(plugin, { contracts: { tools: ["mockplugin_status"] } });

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: ["fuzzplugin"],
      discovery: {
        candidates: [
          {
            idHint: "fuzzplugin",
            source: plugin.file,
            rootDir: plugin.dir,
            origin: "bundled",
          },
        ],
        diagnostics: [],
      },
    });

    expect(registry.plugins.find((record) => record.id === "fuzzplugin")?.status).toBe("loaded");
    expect(registry.tools.flatMap((entry) => entry.names)).toEqual(["mockplugin_status"]);
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.pluginId === "fuzzplugin" &&
          entry.message === "plugin tool registration missing readable tool name",
      ),
    ).toBe(true);
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.pluginId === "fuzzplugin" && entry.message.startsWith("failed to load plugin:"),
      ),
    ).toBe(false);
  });
});
