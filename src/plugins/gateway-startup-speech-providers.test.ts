import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectConfiguredSpeechProviderIds } from "./gateway-startup-speech-providers.js";

describe("collectConfiguredSpeechProviderIds", () => {
  it("skips unreadable synthetic plugin entries and preserves readable speech config", () => {
    const entries: Record<string, unknown> = {
      mockplugin: {
        config: {
          tts: {
            provider: "edge",
          },
        },
      },
    };
    Object.defineProperty(entries, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("unreadable plugin entry");
      },
    });

    const providers = collectConfiguredSpeechProviderIds({
      plugins: { entries },
    } as OpenClawConfig);

    expect([...providers]).toEqual(["microsoft"]);
  });

  it("skips unreadable synthetic channel and account entries", () => {
    const accounts: Record<string, unknown> = {
      mockplugin: {
        voice: {
          tts: {
            providers: {
              openai: { enabled: true },
            },
          },
        },
      },
    };
    Object.defineProperty(accounts, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("unreadable account entry");
      },
    });
    const channels: Record<string, unknown> = {
      mockplugin: {
        accounts,
        voice: {
          tts: {
            persona: "readable",
            personas: {
              readable: { provider: "elevenlabs" },
            },
          },
        },
      },
    };
    Object.defineProperty(channels, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("unreadable channel entry");
      },
    });

    const providers = collectConfiguredSpeechProviderIds({
      channels,
    } as OpenClawConfig);

    expect([...providers].toSorted()).toEqual(["elevenlabs", "openai"]);
  });
});
