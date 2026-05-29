import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectProviderToolSchemasWithPlugin: vi.fn(),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: mocks.inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

const { logProviderToolSchemaDiagnostics, normalizeProviderToolSchemas } =
  await import("./tool-schema-runtime.js");

describe("tool schema runtime diagnostics", () => {
  beforeEach(() => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
  });

  it("stays quiet when a provider reports no diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("passes through provider runtime loading policy for normalization", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockReturnValueOnce(tools);

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        allowRuntimePluginLoad: false,
      }),
    ).toBe(tools);

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "example",
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("logs one summarized warning for provider tool schema diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      { toolName: "alpha", toolIndex: 0, violations: ["one", "two"] },
      { toolName: "beta", toolIndex: 1, violations: ["one"] },
    ]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 2 tools for example: alpha (2 violations), beta (1 violation)",
      {
        provider: "example",
        toolCount: 2,
        diagnosticCount: 2,
        tools: ["0:alpha", "1:beta"],
        diagnostics: [
          { index: 0, tool: "alpha", violations: ["one", "two"], violationCount: 2 },
          { index: 1, tool: "beta", violations: ["one"], violationCount: 1 },
        ],
      },
    );
  });

  it("keeps original tools when provider schema normalization throws", () => {
    const tools = [{ name: "fuzz_move_delta" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("fuzzplugin normalize failed");
    });

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
      }),
    ).toBe(tools);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema normalization failed for example: fuzzplugin normalize failed",
      {
        provider: "example",
        toolCount: 1,
      },
    );
  });

  it("keeps original tools when provider schema normalization throws an unreadable value", () => {
    const tools = [{ name: "fuzz_move_delta" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw {
        toString() {
          throw new Error("fuzzplugin thrown value stringifier failed");
        },
      };
    });

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
      }),
    ).toBe(tools);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema normalization failed for example: unknown error",
      {
        provider: "example",
        toolCount: 1,
      },
    );
  });

  it("keeps diagnostics logging bounded for unreadable synthetic tool metadata", () => {
    const tool = {};
    Object.defineProperty(tool, "name", {
      get() {
        throw new Error("fuzzplugin tool name getter failed");
      },
    });
    const diagnostic = {
      toolIndex: 0,
      toolName: "fuzz_move_delta",
    };
    Object.defineProperty(diagnostic, "violations", {
      get() {
        throw new Error("fuzzplugin diagnostic violations getter failed");
      },
    });
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([diagnostic]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [tool] as never,
    });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 1 tool for example: fuzz_move_delta (1 violation)",
      {
        provider: "example",
        toolCount: 1,
        diagnosticCount: 1,
        tools: ["0:unreadable"],
        diagnostics: [
          {
            index: 0,
            tool: "fuzz_move_delta",
            violations: ["fuzz_move_delta.diagnostic"],
            violationCount: 1,
          },
        ],
      },
    );
  });

  it("keeps diagnostics logging quiet when provider inspection throws", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockImplementationOnce(() => {
      throw new Error("fuzzplugin inspect failed");
    });

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "fuzz_move_delta" }] as never,
    });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics failed for example: fuzzplugin inspect failed",
      {
        provider: "example",
        toolCount: 1,
      },
    );
  });
});
