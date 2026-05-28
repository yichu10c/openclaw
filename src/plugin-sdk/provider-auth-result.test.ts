import { describe, expect, it } from "vitest";
import { buildOauthProviderAuthResult } from "./provider-auth-result.js";

describe("buildOauthProviderAuthResult", () => {
  it("normalizes retired Gemini defaults before emitting config patches", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "google",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": {},
          },
        },
      },
    });
  });

  it("normalizes retired Gemini refs inside explicit config patches", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "google",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
      configPatch: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview", "openai/gpt-5.5"],
            },
            models: {
              "google/gemini-3-pro-preview": { alias: "gemini" },
            },
          },
        },
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "google/gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3.1-pro-preview",
            fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
          },
          models: {
            "google/gemini-3.1-pro-preview": { alias: "gemini" },
          },
        },
      },
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "google/gemini-3.1-pro-preview",
                name: "Gemini 3 Pro",
                contextWindow: 1_048_576,
                maxTokens: 65_536,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: true,
              },
            ],
          },
        },
      },
    });
  });

  it("copies hostile auth-result model arrays before normalization", () => {
    const fallbacks = Object.assign(["google/gemini-3-pro-preview", "mockplugin/model"], {
      map() {
        throw new Error("fuzzplugin fallback map failed");
      },
      [Symbol.iterator]() {
        throw new Error("mockplugin fallback iterator failed");
      },
    });
    Object.defineProperty(fallbacks, "2", {
      enumerable: true,
      get() {
        throw new Error("mockplugin fallback read failed");
      },
    });

    const providerModels = Object.assign(
      [
        {
          id: "google/gemini-3-pro-preview",
          name: "Gemini 3 Pro",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: true,
        },
      ],
      {
        map() {
          throw new Error("fuzzplugin provider models map failed");
        },
        [Symbol.iterator]() {
          throw new Error("mockplugin provider models iterator failed");
        },
      },
    );
    Object.defineProperty(providerModels, "1", {
      enumerable: true,
      get() {
        throw new Error("mockplugin provider model read failed");
      },
    });

    const result = buildOauthProviderAuthResult({
      providerId: "fuzzplugin",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
      configPatch: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks,
            },
          },
        },
        models: {
          providers: {
            fuzzplugin: {
              baseUrl: "https://example.invalid/v1",
              models: providerModels,
            },
          },
        },
      },
    });

    expect(result.configPatch).toMatchObject({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3.1-pro-preview",
            fallbacks: ["google/gemini-3.1-pro-preview", "mockplugin/model"],
          },
        },
      },
      models: {
        providers: {
          fuzzplugin: {
            models: [
              {
                id: "google/gemini-3.1-pro-preview",
              },
            ],
          },
        },
      },
    });
    expect(
      (result.configPatch?.models?.providers?.fuzzplugin?.models as { map?: unknown }).map,
    ).not.toBe(providerModels.map);
  });

  it("ignores unreadable provider auth config maps", () => {
    const providers = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("fuzzplugin providers keys failed");
        },
      },
    ) as Record<string, never>;

    const result = buildOauthProviderAuthResult({
      providerId: "fuzzplugin",
      defaultModel: "fuzzplugin/default",
      access: "access-token",
      configPatch: {
        models: { providers },
      },
    });

    expect(result.configPatch?.models?.providers).toBeUndefined();
  });

  it("drops unreadable provider auth config entries", () => {
    const providers = {
      fuzzplugin: {
        baseUrl: "https://example.invalid/v1",
        models: [
          {
            id: "fuzz-model",
            name: "Fuzz",
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: true,
          },
        ],
      },
      get mockplugin() {
        throw new Error("mockplugin provider config read failed");
      },
    };

    const result = buildOauthProviderAuthResult({
      providerId: "fuzzplugin",
      defaultModel: "fuzzplugin/default",
      access: "access-token",
      configPatch: {
        models: { providers },
      },
    });

    expect(Object.keys(result.configPatch?.models?.providers ?? {})).toEqual(["fuzzplugin"]);
  });
});
