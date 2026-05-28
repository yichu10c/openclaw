import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredProviderConfig,
  resolveProviderConfigApiOwnerHint,
} from "./provider-config-owner.js";

describe("provider config owner lookup", () => {
  it("skips unreadable provider maps while resolving api owner hints", () => {
    const config = {
      models: {
        providers: new Proxy(
          {
            mockprovider: {
              api: "fuzzplugin",
              models: [],
            },
          },
          {
            ownKeys() {
              throw new Error("fuzzplugin provider keys failed");
            },
          },
        ),
      },
    } as OpenClawConfig;

    expect(resolveConfiguredProviderConfig({ provider: "mock provider", config })).toBeUndefined();
    expect(
      resolveProviderConfigApiOwnerHint({ provider: "mock provider", config }),
    ).toBeUndefined();
  });

  it("skips unreadable provider entries while preserving readable api owner hints", () => {
    const config = {
      models: {
        providers: {
          unreadable: new Proxy(
            {},
            {
              get() {
                throw new Error("mockplugin provider entry failed");
              },
            },
          ),
          "mock provider": {
            api: "fuzzplugin",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveProviderConfigApiOwnerHint({ provider: "mock provider", config })).toBe(
      "fuzzplugin",
    );
  });
});
