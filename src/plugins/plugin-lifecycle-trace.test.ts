import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "./plugin-lifecycle-trace.js";

describe("plugin lifecycle trace", () => {
  const originalTraceEnv = process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function requireErrorMessage(index = 0): unknown {
    const call = errorSpy.mock.calls[index];
    if (!call) {
      throw new Error(`expected console.error call ${index}`);
    }
    return call[0];
  }

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalTraceEnv === undefined) {
      delete process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE;
    } else {
      process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE = originalTraceEnv;
    }
    errorSpy.mockRestore();
  });

  it("does not emit when the trace env var is disabled", () => {
    delete process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE;

    expect(tracePluginLifecyclePhase("config read", () => "done")).toBe("done");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("emits a successful sync phase with details when enabled", () => {
    process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE = "1";

    expect(
      tracePluginLifecyclePhase("config read", () => 42, {
        command: "inspect",
        includeDisabled: true,
        skipped: undefined,
      }),
    ).toBe(42);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(requireErrorMessage()).toMatch(
      /^\[plugins:lifecycle\] phase="config read" ms=\d+\.\d{2} status=ok command="inspect" includeDisabled=true$/,
    );
  });

  it("emits failed sync phases before rethrowing", () => {
    process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE = "true";
    const error = new Error("boom");

    expect(() =>
      tracePluginLifecyclePhase("registry refresh", () => {
        throw error;
      }),
    ).toThrow(error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(requireErrorMessage()).toMatch(
      /^\[plugins:lifecycle\] phase="registry refresh" ms=\d+\.\d{2} status=error$/,
    );
  });

  it("does not replace plugin lifecycle errors with unreadable trace details", () => {
    process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE = "true";
    const error = new Error("plugin lifecycle failed");
    const details = { pluginId: "fuzzplugin" };
    Object.defineProperty(details, "toolName", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trace detail read failed");
      },
    });

    expect(() =>
      tracePluginLifecyclePhase(
        "mockplugin load",
        () => {
          throw error;
        },
        details as Record<string, boolean | number | string | undefined>,
      ),
    ).toThrow(error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(requireErrorMessage());
    expect(message).toContain('phase="mockplugin load"');
    expect(message).toContain("status=error");
    expect(message).toContain('pluginId="fuzzplugin"');
    expect(message).not.toContain("trace detail read failed");
  });

  it("emits failed async phases before rejecting", async () => {
    process.env.OPENCLAW_PLUGIN_LIFECYCLE_TRACE = "yes";
    const error = new Error("async boom");

    await expect(
      tracePluginLifecyclePhaseAsync("manifest registry", async () => {
        throw error;
      }),
    ).rejects.toThrow(error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(requireErrorMessage()).toMatch(
      /^\[plugins:lifecycle\] phase="manifest registry" ms=\d+\.\d{2} status=error$/,
    );
  });
});
