import { DEFAULT_CONTEXT, DEFAULT_LOCAL_CONTEXT } from "./contextBudget";
import { PROVIDERS, presetFor } from "./providers";
import type { ProviderPreset } from "./providers";
import { invoke, isTauri } from "./tauriBridge";

/** A model on a provider: what the assistant, completions and commits use. */
export type ModelRef = {
  provider: string;
  model: string;
};

/** What the user has set up for one provider. */
export type ProviderState = {
  /** Overrides the preset's base URL; required for custom providers. */
  baseUrl?: string;
  /** The models the user turned on; they appear in the model picker. */
  models: string[];
  /** The last catalogue fetched from the provider, for the picker list. */
  catalogue: string[];
  /** Probe round-trip per model, so a stalled model can fall back to a fast one. */
  latency: Record<string, number>;
  /** Context window per model, as the provider's model list reports it. */
  contextWindows: Record<string, number>;
  /** Context window per model, set by the user; wins over the reported one. */
  contextSet: Record<string, number>;
  checkedAt: number | null;
};

/** A provider the user added by hand: any OpenAI-compatible endpoint. */
export type CustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  key: "required" | "optional";
};

export type AssistantSettings = {
  providers: Record<string, ProviderState>;
  custom: CustomProvider[];
  /** The model the assistant chats with. */
  chat: ModelRef | null;
  /** Inline completions; null means the chat model. A small fast one is best. */
  completion: ModelRef | null;
  /** API keys by provider id. Desktop: from the OS credential store, never saved here. */
  keys: Record<string, string>;
};

export const emptyAssistantSettings: AssistantSettings = {
  providers: {},
  custom: [],
  chat: null,
  completion: null,
  keys: {},
};

export const emptyProviderState: ProviderState = {
  models: [],
  catalogue: [],
  latency: {},
  contextWindows: {},
  contextSet: {},
  checkedAt: null,
};

/** Everything the Rust side (or a browser fetch) needs to reach a model. */
export type ModelTarget = {
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

const STORAGE_KEY = "nexium.assistant.providers";
/** Settings from before providers existed: one NVIDIA key and its models. */
const LEGACY_KEY = "nexium.assistant.nim";

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};

  if (value && typeof value === "object") {
    for (const [id, ms] of Object.entries(value)) {
      if (typeof ms === "number" && Number.isFinite(ms)) {
        out[id] = ms;
      }
    }
  }

  return out;
}

function modelRef(value: unknown): ModelRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const { provider, model } = value as Record<string, unknown>;

  return typeof provider === "string" && typeof model === "string" && model
    ? { provider, model }
    : null;
}

function parseProvider(value: unknown): ProviderState {
  const raw = (value ?? {}) as Record<string, unknown>;

  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    models: strings(raw.models),
    catalogue: strings(raw.catalogue),
    latency: numbers(raw.latency),
    contextWindows: numbers(raw.contextWindows),
    contextSet: numbers(raw.contextSet),
    checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null,
  };
}

function parseCustom(value: unknown): CustomProvider[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const raw = (item ?? {}) as Record<string, unknown>;

    return typeof raw.id === "string" &&
      /^custom-[a-z0-9]+$/.test(raw.id) &&
      typeof raw.name === "string" &&
      typeof raw.baseUrl === "string"
      ? [
          {
            id: raw.id,
            name: raw.name,
            baseUrl: raw.baseUrl,
            key: raw.key === "optional" ? "optional" : "required",
          } as CustomProvider,
        ]
      : [];
  });
}

/** The single-provider settings older builds wrote, as the new shape. */
function migrateLegacy(): AssistantSettings | null {
  const raw = localStorage.getItem(LEGACY_KEY);

  if (!raw) {
    return null;
  }

  try {
    const legacy = JSON.parse(raw) as Record<string, unknown>;
    const models = strings(legacy.workingModels);
    const model = typeof legacy.model === "string" ? legacy.model : "";
    const apiKey = typeof legacy.apiKey === "string" ? legacy.apiKey : "";

    return {
      ...emptyAssistantSettings,
      providers: {
        nvidia: {
          ...emptyProviderState,
          models,
          catalogue: models,
          latency: numbers(legacy.latency),
          checkedAt:
            typeof legacy.verifiedAt === "number" ? legacy.verifiedAt : null,
        },
      },
      chat: model ? { provider: "nvidia", model } : null,
      keys: apiKey ? { nvidia: apiKey } : {},
    };
  } catch {
    return null;
  }
}

export function loadAssistantSettings(): AssistantSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return migrateLegacy() ?? emptyAssistantSettings;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providers: Record<string, ProviderState> = {};

    if (parsed.providers && typeof parsed.providers === "object") {
      for (const [id, value] of Object.entries(parsed.providers)) {
        providers[id] = parseProvider(value);
      }
    }

    return {
      providers,
      custom: parseCustom(parsed.custom),
      chat: modelRef(parsed.chat),
      completion: modelRef(parsed.completion),
      // The browser-only dev build has no credential store.
      keys:
        !isTauri() && parsed.keys && typeof parsed.keys === "object"
          ? Object.fromEntries(
              Object.entries(parsed.keys as Record<string, unknown>).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            )
          : {},
    };
  } catch {
    return emptyAssistantSettings;
  }
}

/**
 * Everything but the keys goes to `localStorage`. In the desktop shell keys go
 * to the OS credential store (see `saveProviderKey`); the browser-only dev
 * build has no credential store and keeps them here.
 */
export function saveAssistantSettings(settings: AssistantSettings): void {
  try {
    const stored = isTauri() ? { ...settings, keys: {} } : settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Private mode or a full quota: the session still works without persistence.
  }
}

/** Stores (or with an empty key removes) one provider's key. */
export async function saveProviderKey(
  provider: string,
  key: string,
): Promise<void> {
  if (isTauri()) {
    await invoke("secret_set_key", { provider, key });
  }
}

/**
 * Reads every provider's key from the credential store. A key an older build
 * left in `localStorage` is moved there first.
 */
export async function loadStoredKeys(
  settings: AssistantSettings,
): Promise<Record<string, string>> {
  if (!isTauri()) {
    return settings.keys;
  }

  for (const [provider, key] of Object.entries(settings.keys)) {
    try {
      await saveProviderKey(provider, key);
    } catch (cause) {
      console.error("An API key could not be moved to the credential store:", cause);
    }
  }

  const ids = [
    ...PROVIDERS.map((preset) => preset.id),
    ...settings.custom.map((provider) => provider.id),
  ];

  try {
    return {
      ...settings.keys,
      ...(await invoke<Record<string, string>>("secret_get_keys", {
        providers: ids,
      })),
    };
  } catch (cause) {
    console.error("API keys could not be read:", cause);
    return settings.keys;
  }
}

/** A provider's display info, whether it is a preset or one the user added. */
export type ProviderInfo = Pick<
  ProviderPreset,
  "id" | "name" | "category" | "key" | "note" | "caution" | "docsUrl"
> & {
  defaultBaseUrl: string | null;
  custom: boolean;
};

export function providerInfo(
  settings: AssistantSettings,
  id: string,
): ProviderInfo | null {
  const preset = presetFor(id);

  if (preset) {
    return { ...preset, defaultBaseUrl: preset.baseUrl, custom: false };
  }

  const custom = settings.custom.find((provider) => provider.id === id);

  return custom
    ? {
        id: custom.id,
        name: custom.name,
        category: "free",
        key: custom.key,
        note: "Custom OpenAI-compatible provider.",
        defaultBaseUrl: custom.baseUrl,
        custom: true,
      }
    : null;
}

export function baseUrlFor(settings: AssistantSettings, id: string): string {
  return (
    settings.providers[id]?.baseUrl?.trim() ||
    providerInfo(settings, id)?.defaultBaseUrl ||
    ""
  );
}

/** Has what it needs to send a request: a base URL and, if required, a key. */
export function providerReady(settings: AssistantSettings, id: string): boolean {
  const info = providerInfo(settings, id);

  if (!info || !baseUrlFor(settings, id)) {
    return false;
  }

  return info.key !== "required" || Boolean(settings.keys[id]?.trim());
}

/** Ready and has at least one model turned on. */
export function providerConnected(
  settings: AssistantSettings,
  id: string,
): boolean {
  return (
    providerReady(settings, id) &&
    (settings.providers[id]?.models.length ?? 0) > 0
  );
}

export function targetFor(
  settings: AssistantSettings,
  ref: ModelRef | null,
): ModelTarget | null {
  if (!ref || !providerReady(settings, ref.provider)) {
    return null;
  }

  return {
    provider: ref.provider,
    name: providerInfo(settings, ref.provider)?.name ?? ref.provider,
    baseUrl: baseUrlFor(settings, ref.provider),
    apiKey: settings.keys[ref.provider] ?? "",
    model: ref.model,
  };
}

export type ModelOption = ModelRef & {
  providerName: string;
  latency?: number;
};

/** Every turned-on model of every ready provider, for the pickers. */
export function modelOptions(settings: AssistantSettings): ModelOption[] {
  return Object.entries(settings.providers).flatMap(([provider, state]) => {
    const info = providerInfo(settings, provider);

    if (!info || !providerReady(settings, provider)) {
      return [];
    }

    return state.models.map((model) => ({
      provider,
      model,
      providerName: info.name,
      latency: state.latency[model],
    }));
  });
}

/** Where a model's context window figure comes from. */
export type ContextWindow = {
  tokens: number;
  source: "set" | "reported" | "assumed";
};

/**
 * The context window to plan against: the user's figure, else the provider's,
 * else a cautious default (smaller for local servers, which usually run with a
 * short context unless configured otherwise).
 */
export function contextWindowFor(
  settings: AssistantSettings,
  ref: ModelRef | null,
): ContextWindow {
  if (!ref) {
    return { tokens: DEFAULT_CONTEXT, source: "assumed" };
  }

  const state = settings.providers[ref.provider];
  const set = state?.contextSet[ref.model];

  if (set) {
    return { tokens: set, source: "set" };
  }

  const reported = state?.contextWindows[ref.model];

  if (reported) {
    return { tokens: reported, source: "reported" };
  }

  const local = providerInfo(settings, ref.provider)?.category === "local";

  return {
    tokens: local ? DEFAULT_LOCAL_CONTEXT : DEFAULT_CONTEXT,
    source: "assumed",
  };
}

export const sameModel = (a: ModelRef | null, b: ModelRef | null) =>
  Boolean(a && b && a.provider === b.provider && a.model === b.model);
