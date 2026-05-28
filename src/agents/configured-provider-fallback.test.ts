import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";

describe("resolveConfiguredProviderFallback", () => {
  it("ignores unreadable configured provider maps", () => {
    const cfg = {
      models: {
        providers: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("fuzzplugin provider keys failed");
            },
          },
        ),
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredProviderFallback({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toBeNull();
  });

  it("skips unreadable configured provider model arrays", () => {
    const cfg = {
      models: {
        providers: {
          mockplugin: {
            models: new Proxy([], {
              get(target, key, receiver) {
                if (key === "length") {
                  throw new Error("mockplugin model length failed");
                }
                return Reflect.get(target, key, receiver);
              },
            }),
          },
          fuzzplugin: {
            models: [{ id: "fuzz-model" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredProviderFallback({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({ provider: "fuzzplugin", model: "fuzz-model" });
  });
});
