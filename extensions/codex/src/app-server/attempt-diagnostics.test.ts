import { describe, expect, it } from "vitest";
import {
  buildCodexDiagnosticToolDefinitions,
  buildCodexPluginThreadConfigEligibilityLogData,
} from "./attempt-diagnostics.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";

function defineThrowingProperty(record: Record<string, unknown>, key: string, message: string) {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
}

describe("Codex app-server attempt diagnostics", () => {
  it("skips unreadable synthetic tool names in diagnostic definitions", () => {
    const unreadableNameTool = {
      description: "Synthetic unreadable diagnostic tool",
      parameters: { type: "object", properties: {} },
    };
    defineThrowingProperty(
      unreadableNameTool,
      "name",
      "fuzzplugin diagnostic tool name read failed",
    );
    const unreadableDescriptionTool = {
      name: "fuzz_move_diagnostics",
      parameters: { type: "object", properties: {} },
    };
    defineThrowingProperty(
      unreadableDescriptionTool,
      "description",
      "mockplugin diagnostic tool description read failed",
    );

    expect(
      buildCodexDiagnosticToolDefinitions([
        unreadableNameTool,
        unreadableDescriptionTool,
        {
          name: "message",
          description: "Healthy tool",
          parameters: { type: "object", properties: {} },
        },
      ]),
    ).toEqual([
      {
        name: "fuzz_move_diagnostics",
        description: "",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "message",
        description: "Healthy tool",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("omits unreadable synthetic tool parameters from diagnostic definitions", () => {
    const tool = {
      name: "fuzz_move_report",
      description: "Synthetic diagnostic tool",
    };
    defineThrowingProperty(tool, "inputSchema", "fuzzplugin diagnostic schema read failed");
    defineThrowingProperty(tool, "parameters", "mockplugin diagnostic parameters read failed");

    expect(buildCodexDiagnosticToolDefinitions([tool])).toEqual([
      {
        name: "fuzz_move_report",
        description: "Synthetic diagnostic tool",
        parameters: undefined,
      },
    ]);
  });

  it("redacts plugin thread config eligibility log data", () => {
    const appServer = {
      start: {
        transport: "websocket" as const,
        command: "codex",
        commandSource: "config" as const,
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Test-Token": "header-secret",
        },
        env: {
          CODEX_HOME: "/tmp/codex-home",
          OPENAI_API_KEY: "env-secret",
        },
      },
      codeModeOnly: false,
      requestTimeoutMs: 60_000,
      turnCompletionIdleTimeoutMs: 60_000,
      approvalPolicy: "never" as const,
      approvalsReviewer: "user" as const,
      sandbox: "danger-full-access" as const,
      serviceTier: "priority" as const,
    };
    const resolvedPluginPolicy = resolveCodexPluginsPolicy({
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    });

    const logData = buildCodexPluginThreadConfigEligibilityLogData({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      pluginThreadConfigRequired: true,
      resolvedPluginPolicy,
      enabledPluginConfigKeys: ["google-calendar"],
      pluginAppCacheKey: buildCodexPluginAppCacheKey({
        appServer,
        agentDir: "/tmp/agent",
        authProfileId: "openai-codex:work",
        accountId: "account-work",
        envApiKeyFingerprint: "env-key",
      }),
      startupAuthProfileId: "openai-codex:work",
      appServer,
    });

    expect(logData).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        enabled: true,
        policyConfigured: true,
        policyEnabled: true,
        pluginConfigKeys: ["google-calendar"],
        enabledPluginConfigKeys: ["google-calendar"],
        appCacheKeyFingerprint: expect.stringMatching(/^sha256:/),
        authProfileId: "openai-codex:work",
        appServerTransport: "websocket",
        appServerCommandSource: "config",
      }),
    );
    expect(logData).not.toHaveProperty("appCacheKeyInput");
    const serialized = JSON.stringify(logData);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("env-secret");
    expect(serialized).not.toContain("/tmp/codex-home");
  });
});
