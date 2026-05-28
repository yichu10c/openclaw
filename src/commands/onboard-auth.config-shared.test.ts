import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOpencodeZenModelDefault,
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithModelCatalogPreset,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
} from "../plugin-sdk/provider-onboard.js";

function makeModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow: 4096,
    maxTokens: 1024,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
  };
}

function makeUnreadableProviderMap(): Record<string, ModelProviderConfig> {
  const providers = {
    fuzzplugin: {
      api: "openai-completions",
      baseUrl: "https://fuzz.example.com/v1",
      models: [makeModel("model-fuzz")],
    },
    mockplugin: {
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v1",
      models: [makeModel("model-a")],
    },
  };
  return new Proxy(providers, {
    get(target, key, receiver) {
      if (key === "fuzzplugin") {
        throw new Error("unreadable synthetic provider");
      }
      return Reflect.get(target, key, receiver);
    },
  }) as Record<string, ModelProviderConfig>;
}

function makeUnenumerableProviderMap(): Record<string, ModelProviderConfig> {
  const providers = {
    mockplugin: {
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v1",
      models: [makeModel("model-a")],
    },
  };
  return new Proxy(providers, {
    ownKeys() {
      throw new Error("unreadable synthetic provider map");
    },
  }) as Record<string, ModelProviderConfig>;
}

function makeConfigWithUnenumerableModels(
  providers: Record<string, ModelProviderConfig>,
): OpenClawConfig {
  return {
    models: new Proxy(
      {
        mode: "merge",
        providers,
      },
      {
        ownKeys() {
          throw new Error("unreadable synthetic models config");
        },
      },
    ) as OpenClawConfig["models"],
  };
}

function makeConfigWithUnenumerableAgentModels(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: new Proxy(
          {
            "mockplugin/model-a": { alias: "Mock" },
          },
          {
            ownKeys() {
              throw new Error("unreadable synthetic agent model map");
            },
          },
        ),
      },
    },
    models: {
      providers: {
        mockplugin: {
          api: "openai-completions",
          baseUrl: "https://mock.example.com/v1",
          models: [makeModel("model-a")],
        },
      },
    },
  };
}

function makeConfigWithUnreadableAgentModelEntry(): OpenClawConfig {
  const models = {};
  Object.defineProperty(models, "mockplugin/model-a", {
    enumerable: true,
    get() {
      throw new Error("unreadable synthetic agent model entry");
    },
  });
  return {
    agents: {
      defaults: {
        models,
      },
    },
    models: {
      providers: {
        mockplugin: {
          api: "openai-completions",
          baseUrl: "https://mock.example.com/v1",
          models: [makeModel("model-a")],
        },
      },
    },
  };
}

function makeConfigWithUnreadablePrimary(): OpenClawConfig {
  const model = {};
  Object.defineProperty(model, "primary", {
    enumerable: true,
    get() {
      throw new Error("unreadable synthetic primary");
    },
  });
  return {
    agents: {
      defaults: {
        model,
      },
    },
    models: {
      providers: {
        mockplugin: {
          api: "openai-completions",
          baseUrl: "https://mock.example.com/v1",
          models: [makeModel("model-a")],
        },
      },
    },
  };
}

describe("onboard auth provider config merges", () => {
  const agentModels: Record<string, AgentModelEntryConfig> = {
    "custom/model-a": {},
  };

  it("appends missing default models to existing provider models", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://old.example.com/v1",
            apiKey: "  test-key  ",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.models?.providers?.custom?.apiKey).toBe("test-key");
    expect(next.agents?.defaults?.models).toEqual(agentModels);
  });

  it("skips unreadable synthetic provider entries when applying default models", () => {
    const next = applyProviderConfigWithDefaultModels(
      {
        models: {
          providers: makeUnreadableProviderMap(),
        },
      },
      {
        agentModels,
        providerId: "mockplugin",
        api: "openai-completions",
        baseUrl: "https://mock.example.com/v2",
        defaultModels: [makeModel("model-b")],
        defaultModelId: "model-b",
      },
    );

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["mockplugin"]);
    expect(next.models?.providers?.mockplugin?.models?.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
  });

  it("does not overwrite providers when synthetic provider enumeration fails", () => {
    const providers = makeUnenumerableProviderMap();
    const cfg: OpenClawConfig = {
      models: {
        providers,
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next).toBe(cfg);
  });

  it("does not overwrite models when synthetic models config enumeration fails", () => {
    const cfg = makeConfigWithUnenumerableModels(makeUnreadableProviderMap());

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next).toBe(cfg);
  });

  it("does not overwrite agent model aliases when synthetic agent model enumeration fails", () => {
    const cfg = makeConfigWithUnenumerableAgentModels();

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next).toBe(cfg);
  });

  it("does not overwrite agent model aliases when a synthetic agent model entry is unreadable", () => {
    const cfg = makeConfigWithUnreadableAgentModelEntry();

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next).toBe(cfg);
  });

  it("preserves existing agent model entries when adding provider models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "GPT" },
          },
        },
      },
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://old.example.com/v1",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "GPT" },
      ...agentModels,
    });
  });

  it("normalizes retired Google agent model keys when adding provider models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {
              alias: "Gemini",
              params: { thinkingLevel: "high" },
            },
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels: {
        "google/gemini-3.1-pro-preview": {
          params: { serviceTier: "standard" },
        },
      },
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Gemini",
        params: { thinkingLevel: "high", serviceTier: "standard" },
      },
    });
    expect(next.agents?.defaults?.models).not.toHaveProperty("google/gemini-3-pro-preview");
  });

  it("merges model catalogs without duplicating existing model ids", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.com/v1",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithModelCatalog(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      catalogModels: [makeModel("model-a"), makeModel("model-c")],
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-c",
    ]);
  });

  it("normalizes retired Google model ids before emitting provider catalog config", () => {
    const next = applyProviderConfigWithModelCatalog(
      {
        models: {
          providers: {
            kilocode: {
              api: "openai-completions",
              baseUrl: "https://example.com/v1",
              models: [makeModel("google/gemini-3-pro-preview")],
            },
          },
        },
      },
      {
        agentModels,
        providerId: "kilocode",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("google/gemini-3.1-pro-preview")],
      },
    );

    expect(next.models?.providers?.kilocode?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("normalizes retired Google provider catalog ids when applying only an agent default", () => {
    const next = applyAgentDefaultModelPrimary(
      {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [makeModel("google/gemini-3-pro-preview")],
            },
            kilocode: {
              api: "openai-completions",
              baseUrl: "https://kilocode.example.com/v1",
              models: [makeModel("google/gemini-3-pro-preview")],
            },
          },
        },
      },
      "google/gemini-3.1-pro-preview",
    );

    expect(next.models?.providers?.google?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
    expect(next.models?.providers?.kilocode?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
    expect(next.agents?.defaults?.model).toEqual({ primary: "google/gemini-3.1-pro-preview" });
  });

  it("skips unreadable synthetic provider entries when applying only an agent default", () => {
    const next = applyAgentDefaultModelPrimary(
      {
        models: {
          providers: makeUnreadableProviderMap(),
        },
      },
      "mockplugin/model-a",
    );

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["mockplugin"]);
    expect(next.models?.providers?.mockplugin?.models?.map((model) => model.id)).toEqual([
      "model-a",
    ]);
    expect(next.agents?.defaults?.model).toEqual({ primary: "mockplugin/model-a" });
  });

  it("preserves providers when applying an agent default and provider enumeration fails", () => {
    const providers = makeUnenumerableProviderMap();
    const next = applyAgentDefaultModelPrimary(
      {
        models: {
          providers,
        },
      },
      "mockplugin/model-a",
    );

    expect(next.models?.providers).toBe(providers);
    expect(next.agents?.defaults?.model).toEqual({ primary: "mockplugin/model-a" });
  });

  it("preserves models when applying an agent default and models enumeration fails", () => {
    const cfg = makeConfigWithUnenumerableModels(makeUnreadableProviderMap());
    const next = applyAgentDefaultModelPrimary(cfg, "mockplugin/model-a");

    expect(next.models).toBe(cfg.models);
    expect(next.agents?.defaults?.model).toEqual({ primary: "mockplugin/model-a" });
  });

  it("preserves agent model aliases when applying a primary and agent model enumeration fails", () => {
    const cfg = makeConfigWithUnenumerableAgentModels();
    const next = applyAgentDefaultModelPrimary(cfg, "mockplugin/model-a");

    expect(next.agents?.defaults?.models).toBe(cfg.agents?.defaults?.models);
    expect(next.agents?.defaults?.model).toEqual({ primary: "mockplugin/model-a" });
  });

  it("preserves agent model aliases when applying a primary and an agent model entry is unreadable", () => {
    const cfg = makeConfigWithUnreadableAgentModelEntry();
    const next = applyAgentDefaultModelPrimary(cfg, "mockplugin/model-a");

    expect(next.agents?.defaults?.models).toBe(cfg.agents?.defaults?.models);
    expect(next.agents?.defaults?.model).toEqual({ primary: "mockplugin/model-a" });
  });

  it("supports single default model convenience wrapper", () => {
    const next = applyProviderConfigWithDefaultModel(
      {},
      {
        agentModels,
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
      },
    );

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual(["model-z"]);
  });

  it("preserves explicit aliases when adding provider alias presets", () => {
    expect(
      withAgentModelAliases(
        {
          "custom/model-a": { alias: "Pinned" },
        },
        [{ modelRef: "custom/model-a", alias: "Preset" }, "custom/model-b"],
      ),
    ).toEqual({
      "custom/model-a": { alias: "Pinned" },
      "custom/model-b": {},
    });
  });

  it("normalizes retired Google alias presets before emitting config", () => {
    expect(
      withAgentModelAliases(
        {
          "google/gemini-3-pro-preview": { alias: "Pinned" },
        },
        [{ modelRef: "google/gemini-3-pro-preview", alias: "Preset" }],
      ),
    ).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "Pinned" },
    });
  });

  it("applies default-model presets with alias and primary model", () => {
    const next = applyProviderConfigWithDefaultModelPreset(
      {
        agents: {
          defaults: {
            models: {
              "custom/model-z": { alias: "Pinned" },
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
        aliases: [{ modelRef: "custom/model-z", alias: "Preset" }],
        primaryModelRef: "custom/model-z",
      },
    );

    expect(next.agents?.defaults?.models?.["custom/model-z"]).toEqual({ alias: "Pinned" });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-z" });
  });

  it("does not let default-model presets replace an existing default model", () => {
    const next = applyProviderConfigWithDefaultModelPreset(
      {
        agents: {
          defaults: {
            models: {
              "claude-max-proxy/claude-opus-4-7": {},
              "claude-max-proxy/claude-sonnet-4-6": {},
            },
            model: {
              primary: "claude-max-proxy/claude-opus-4-7",
              fallbacks: ["claude-max-proxy/claude-sonnet-4-6"],
            },
          },
        },
      },
      {
        providerId: "moonshot",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.cn/v1",
        defaultModel: makeModel("kimi-k2.6"),
        aliases: [{ modelRef: "moonshot/kimi-k2.6", alias: "Kimi" }],
        primaryModelRef: "moonshot/kimi-k2.6",
      },
    );

    expect(next.agents?.defaults?.model).toEqual({
      primary: "claude-max-proxy/claude-opus-4-7",
      fallbacks: ["claude-max-proxy/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "claude-max-proxy/claude-opus-4-7": {},
      "claude-max-proxy/claude-sonnet-4-6": {},
      "moonshot/kimi-k2.6": { alias: "Kimi" },
    });
    expect(next.models?.providers?.moonshot?.models?.map((model) => model.id)).toEqual([
      "kimi-k2.6",
    ]);
  });

  it("does not set preset primary models when synthetic provider mutation is skipped", () => {
    const cfg = makeConfigWithUnenumerableModels(makeUnreadableProviderMap());

    const next = applyProviderConfigWithDefaultModelPreset(cfg, {
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModel: makeModel("model-b"),
      primaryModelRef: "mockplugin/model-b",
    });

    expect(next).toBe(cfg);
  });

  it("does not replace unreadable existing primary models from presets", () => {
    const cfg = makeConfigWithUnreadablePrimary();

    const next = applyProviderConfigWithDefaultModelPreset(cfg, {
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModel: makeModel("model-b"),
      primaryModelRef: "mockplugin/model-b",
    });

    expect(next).not.toBe(cfg);
    expect(next.agents?.defaults?.model).toBe(cfg.agents?.defaults?.model);
    expect(next.models?.providers?.mockplugin?.baseUrl).toBe("https://mock.example.com/v2");
  });

  it("does not replace unreadable primary models with the opencode default", () => {
    const cfg = makeConfigWithUnreadablePrimary();

    expect(applyOpencodeZenModelDefault(cfg)).toEqual({ next: cfg, changed: false });
  });

  it("does not apply presets when synthetic agent model enumeration fails", () => {
    const cfg = makeConfigWithUnenumerableAgentModels();

    const next = applyProviderConfigWithDefaultModelPreset(cfg, {
      providerId: "mockplugin",
      api: "openai-completions",
      baseUrl: "https://mock.example.com/v2",
      defaultModel: makeModel("model-b"),
      primaryModelRef: "mockplugin/model-b",
    });

    expect(next).toBe(cfg);
  });

  it("applies catalog presets with alias and merged catalog models", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://example.com/v1",
              models: [makeModel("model-a")],
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("model-a"), makeModel("model-b")],
        aliases: [{ modelRef: "custom/model-b", alias: "Catalog Alias" }],
        primaryModelRef: "custom/model-b",
      },
    );

    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.agents?.defaults?.models?.["custom/model-b"]).toEqual({
      alias: "Catalog Alias",
    });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-b" });
  });

  it("does not let catalog presets replace an existing default model", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        agents: {
          defaults: {
            models: {
              "custom-existing/model-a": {},
            },
            model: {
              primary: "custom-existing/model-a",
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("model-b")],
        aliases: [{ modelRef: "custom/model-b", alias: "Catalog Alias" }],
        primaryModelRef: "custom/model-b",
      },
    );

    expect(next.agents?.defaults?.model).toEqual({ primary: "custom-existing/model-a" });
    expect(next.agents?.defaults?.models).toEqual({
      "custom-existing/model-a": {},
      "custom/model-b": { alias: "Catalog Alias" },
    });
    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual(["model-b"]);
  });
});
