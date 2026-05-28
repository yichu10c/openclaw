import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import { resolvePluginSetupProvider } from "./setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderPlugin,
  ProviderPluginWizard,
  ProviderPluginWizardModelPicker,
  ProviderPluginWizardSetup,
} from "./types.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

export type ProviderWizardOption = {
  value: string;
  label: string;
  hint?: string;
  groupId: string;
  groupLabel: string;
  groupHint?: string;
  onboardingScopes?: Array<"text-inference" | "image-generation" | "music-generation">;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  onboardingFeatured?: boolean;
};

export type ProviderModelPickerEntry = {
  value: string;
  label: string;
  hint?: string;
};

type ProviderWizardProvidersResolver = (params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) => ProviderPlugin[];

let providerWizardProvidersResolverForTest: ProviderWizardProvidersResolver | undefined;

export function setProviderWizardProvidersResolverForTest(
  resolver: ProviderWizardProvidersResolver | undefined,
): () => void {
  const previous = providerWizardProvidersResolverForTest;
  providerWizardProvidersResolverForTest = resolver;
  return () => {
    providerWizardProvidersResolverForTest = previous;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object") {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readProviderId(provider: ProviderPlugin): string {
  return normalizeOptionalString(readRecordValue(provider, "id")) ?? "";
}

function readProviderLabel(provider: ProviderPlugin): string | undefined {
  return normalizeOptionalString(readRecordValue(provider, "label"));
}

function readProviderWizard(provider: ProviderPlugin): ProviderPluginWizard | undefined {
  const wizard = readRecordValue(provider, "wizard");
  return isRecord(wizard) ? (wizard as ProviderPluginWizard) : undefined;
}

function readProviderModelSelectedHook(
  provider: ProviderPlugin,
): ProviderPlugin["onModelSelected"] | undefined {
  const hook = readRecordValue(provider, "onModelSelected");
  return typeof hook === "function" ? (hook as ProviderPlugin["onModelSelected"]) : undefined;
}

function readAuthMethodId(method: ProviderAuthMethod | undefined): string {
  return normalizeOptionalString(readRecordValue(method, "id")) ?? "";
}

function readAuthMethodLabel(method: ProviderAuthMethod): string | undefined {
  return normalizeOptionalString(readRecordValue(method, "label"));
}

function readAuthMethodWizard(method: ProviderAuthMethod): ProviderPluginWizardSetup | undefined {
  const wizard = readRecordValue(method, "wizard");
  return isRecord(wizard) ? (wizard as ProviderPluginWizardSetup) : undefined;
}

function readWizardSetup(
  wizard: ProviderPluginWizard | undefined,
): ProviderPluginWizardSetup | undefined {
  const setup = readRecordValue(wizard, "setup");
  return isRecord(setup) ? (setup as ProviderPluginWizardSetup) : undefined;
}

function readWizardModelPicker(
  wizard: ProviderPluginWizard | undefined,
): ProviderPluginWizardModelPicker | undefined {
  const modelPicker = readRecordValue(wizard, "modelPicker");
  return isRecord(modelPicker) ? (modelPicker as ProviderPluginWizardModelPicker) : undefined;
}

function readWizardString(
  wizard: ProviderPluginWizardSetup | ProviderPluginWizardModelPicker,
  key: string,
): string | undefined {
  return normalizeOptionalString(readRecordValue(wizard, key));
}

function copyOnboardingScopes(
  value: unknown,
): ProviderWizardOption["onboardingScopes"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scopes: NonNullable<ProviderWizardOption["onboardingScopes"]> = [];
  let length: number;
  try {
    length = value.length;
  } catch {
    return undefined;
  }
  for (let index = 0; index < length; index += 1) {
    let entry: unknown;
    try {
      entry = value[index];
    } catch {
      continue;
    }
    if (
      entry === "text-inference" ||
      entry === "image-generation" ||
      entry === "music-generation"
    ) {
      scopes.push(entry);
    }
  }
  return scopes.length > 0 ? scopes : undefined;
}

function resolveWizardSetupChoiceId(
  provider: ProviderPlugin,
  wizard: ProviderPluginWizardSetup,
  authMethods: ProviderAuthMethod[],
): string {
  const explicit = readWizardString(wizard, "choiceId");
  if (explicit) {
    return explicit;
  }
  const explicitMethodId = readWizardString(wizard, "methodId");
  if (explicitMethodId) {
    return buildProviderPluginMethodChoice(readProviderId(provider), explicitMethodId);
  }
  if (authMethods.length === 1) {
    return readProviderId(provider);
  }
  return buildProviderPluginMethodChoice(
    readProviderId(provider),
    readAuthMethodId(authMethods[0]) || "default",
  );
}

function resolveMethodById(
  authMethods: ProviderAuthMethod[],
  methodId?: string,
): ProviderAuthMethod | undefined {
  const normalizedMethodId = normalizeOptionalLowercaseString(methodId);
  if (!normalizedMethodId) {
    return authMethods[0];
  }
  return authMethods.find(
    (method) => normalizeOptionalLowercaseString(readAuthMethodId(method)) === normalizedMethodId,
  );
}

function copyProviderAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  let auth: unknown;
  try {
    auth = provider.auth;
  } catch {
    return [];
  }
  if (!Array.isArray(auth)) {
    return [];
  }

  let length: number;
  try {
    length = auth.length;
  } catch {
    return [];
  }

  const methods: ProviderAuthMethod[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const method = auth[index];
      if (method && typeof method === "object") {
        methods.push(method);
      }
    } catch {
      continue;
    }
  }
  return methods;
}

function listMethodWizardSetups(authMethods: ProviderAuthMethod[]): Array<{
  method: ProviderAuthMethod;
  wizard: ProviderPluginWizardSetup;
}> {
  const setups: Array<{ method: ProviderAuthMethod; wizard: ProviderPluginWizardSetup }> = [];
  for (const method of authMethods) {
    const wizard = readAuthMethodWizard(method);
    if (wizard) {
      setups.push({ method, wizard });
    }
  }
  return setups;
}

function buildSetupOptionForMethod(params: {
  provider: ProviderPlugin;
  wizard: ProviderPluginWizardSetup;
  method: ProviderAuthMethod;
  value: string;
  authMethodCount: number;
}): ProviderWizardOption {
  const providerId = readProviderId(params.provider);
  const providerLabel = readProviderLabel(params.provider) ?? providerId;
  const methodLabel = readAuthMethodLabel(params.method) ?? providerLabel;
  const normalizedGroupId = readWizardString(params.wizard, "groupId") || providerId;
  const onboardingScopes = copyOnboardingScopes(readRecordValue(params.wizard, "onboardingScopes"));
  const assistantPriority = readRecordValue(params.wizard, "assistantPriority");
  const assistantVisibility = readRecordValue(params.wizard, "assistantVisibility");
  return {
    value: normalizeOptionalString(params.value) ?? "",
    label:
      readWizardString(params.wizard, "choiceLabel") ||
      (params.authMethodCount === 1 ? providerLabel : methodLabel),
    hint:
      readWizardString(params.wizard, "choiceHint") ||
      normalizeOptionalString(readRecordValue(params.method, "hint")),
    groupId: normalizedGroupId,
    groupLabel: readWizardString(params.wizard, "groupLabel") || providerLabel,
    groupHint: readWizardString(params.wizard, "groupHint"),
    ...(onboardingScopes ? { onboardingScopes } : {}),
    ...(typeof assistantPriority === "number" && Number.isFinite(assistantPriority)
      ? { assistantPriority }
      : {}),
    ...(assistantVisibility === "visible" || assistantVisibility === "manual-only"
      ? { assistantVisibility }
      : {}),
    ...(readRecordValue(params.wizard, "onboardingFeatured") === true
      ? { onboardingFeatured: true }
      : {}),
  };
}

export function buildProviderPluginMethodChoice(providerId: string, methodId: string): string {
  return `${PROVIDER_PLUGIN_CHOICE_PREFIX}${normalizeOptionalString(providerId) ?? ""}:${normalizeOptionalString(methodId) ?? ""}`;
}

function resolveProviderWizardProviders(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  if (providerWizardProvidersResolverForTest) {
    return providerWizardProvidersResolverForTest(params);
  }
  return resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
}

export function resolveProviderWizardOptions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderWizardOption[] {
  const providers = resolveProviderWizardProviders(params);
  const options: ProviderWizardOption[] = [];

  for (const provider of providers) {
    const authMethods = copyProviderAuthMethods(provider);
    const methodSetups = listMethodWizardSetups(authMethods);
    for (const { method, wizard } of methodSetups) {
      options.push(
        buildSetupOptionForMethod({
          provider,
          wizard,
          method,
          authMethodCount: authMethods.length,
          value:
            readWizardString(wizard, "choiceId") ||
            buildProviderPluginMethodChoice(readProviderId(provider), readAuthMethodId(method)),
        }),
      );
    }
    if (methodSetups.length > 0) {
      continue;
    }
    const setup = readWizardSetup(readProviderWizard(provider));
    if (!setup) {
      continue;
    }
    const explicitMethod = resolveMethodById(authMethods, readWizardString(setup, "methodId"));
    if (explicitMethod) {
      options.push(
        buildSetupOptionForMethod({
          provider,
          wizard: setup,
          method: explicitMethod,
          authMethodCount: authMethods.length,
          value: resolveWizardSetupChoiceId(provider, setup, authMethods),
        }),
      );
      continue;
    }

    for (const method of authMethods) {
      options.push(
        buildSetupOptionForMethod({
          provider,
          wizard: setup,
          method,
          authMethodCount: authMethods.length,
          value: buildProviderPluginMethodChoice(
            readProviderId(provider),
            readAuthMethodId(method),
          ),
        }),
      );
    }
  }

  return options;
}

function resolveModelPickerChoiceValue(
  provider: ProviderPlugin,
  modelPicker: ProviderPluginWizardModelPicker,
  authMethods: ProviderAuthMethod[],
): string {
  const explicitMethodId = readWizardString(modelPicker, "methodId");
  if (explicitMethodId) {
    return buildProviderPluginMethodChoice(readProviderId(provider), explicitMethodId);
  }
  if (authMethods.length === 1) {
    return readProviderId(provider);
  }
  return buildProviderPluginMethodChoice(
    readProviderId(provider),
    readAuthMethodId(authMethods[0]) || "default",
  );
}

export function resolveProviderModelPickerEntries(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerEntry[] {
  const providers = resolveProviderWizardProviders(params);
  const entries: ProviderModelPickerEntry[] = [];

  for (const provider of providers) {
    const modelPicker = readWizardModelPicker(readProviderWizard(provider));
    if (!modelPicker) {
      continue;
    }
    const authMethods = copyProviderAuthMethods(provider);
    entries.push({
      value: resolveModelPickerChoiceValue(provider, modelPicker, authMethods),
      label:
        readWizardString(modelPicker, "label") ||
        `${readProviderLabel(provider) ?? readProviderId(provider)} (custom)`,
      hint: readWizardString(modelPicker, "hint"),
    });
  }

  return entries;
}

export function resolveProviderPluginChoice(params: {
  providers: ProviderPlugin[];
  choice: string;
}): {
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  wizard?: ProviderPluginWizardSetup;
} | null {
  const choice = normalizeOptionalString(params.choice) ?? "";
  if (!choice) {
    return null;
  }

  if (choice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)) {
    const payload = choice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length);
    const separator = payload.indexOf(":");
    const providerId = separator >= 0 ? payload.slice(0, separator) : payload;
    const methodId = separator >= 0 ? payload.slice(separator + 1) : undefined;
    const provider = params.providers.find(
      (entry) => normalizeProviderId(readProviderId(entry)) === normalizeProviderId(providerId),
    );
    if (!provider) {
      return null;
    }
    const method = resolveMethodById(copyProviderAuthMethods(provider), methodId);
    return method ? { provider, method } : null;
  }

  for (const provider of params.providers) {
    const authMethods = copyProviderAuthMethods(provider);
    for (const { method, wizard } of listMethodWizardSetups(authMethods)) {
      const choiceId =
        readWizardString(wizard, "choiceId") ||
        buildProviderPluginMethodChoice(readProviderId(provider), readAuthMethodId(method));
      if ((normalizeOptionalString(choiceId) ?? "") === choice) {
        return { provider, method, wizard };
      }
    }
    const setup = readWizardSetup(readProviderWizard(provider));
    if (setup) {
      const setupChoiceId = resolveWizardSetupChoiceId(provider, setup, authMethods);
      if ((normalizeOptionalString(setupChoiceId) ?? "") === choice) {
        const method = resolveMethodById(authMethods, readWizardString(setup, "methodId"));
        if (method) {
          return { provider, method, wizard: setup };
        }
      }
    }
    if (
      normalizeProviderId(readProviderId(provider)) === normalizeProviderId(choice) &&
      authMethods.length > 0
    ) {
      return { provider, method: authMethods[0] };
    }
  }

  return null;
}

export async function runProviderModelSelectedHook(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const rawModel = params.model.trim();
  if (!rawModel) {
    return;
  }
  const slashIndex = rawModel.indexOf("/");
  const selectedProviderId =
    slashIndex === -1
      ? DEFAULT_PROVIDER
      : normalizeProviderId(rawModel.slice(0, slashIndex).trim());
  if (!selectedProviderId || (slashIndex !== -1 && !rawModel.slice(slashIndex + 1).trim())) {
    return;
  }

  const setupProvider = resolvePluginSetupProvider({
    provider: selectedProviderId,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const provider =
    setupProvider ??
    resolveProviderWizardProviders({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).find((entry) => normalizeProviderId(readProviderId(entry)) === selectedProviderId);
  const onModelSelected = provider ? readProviderModelSelectedHook(provider) : undefined;
  if (!onModelSelected) {
    return;
  }

  await onModelSelected.call(provider, {
    config: params.config,
    model: params.model,
    prompter: params.prompter,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
}
