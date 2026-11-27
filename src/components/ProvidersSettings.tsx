import {
  AlertTriangle,
  Check,
  CircleDot,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  baseUrlFor,
  contextWindowFor,
  emptyProviderState,
  modelOptions,
  providerConnected,
  providerInfo,
  providerReady,
  sameModel,
  saveProviderKey,
  targetFor,
} from "../lib/assistantSettings";
import type {
  AssistantSettings,
  ModelRef,
  ProviderInfo,
  ProviderState,
} from "../lib/assistantSettings";
import { listModels, pingModel, probeModels } from "../lib/llm";
import {
  CATEGORY_LABEL,
  PROVIDERS,
  SOURCE_NOTE,
  baseUrlProblem,
} from "../lib/providers";
import type { ProviderCategory } from "../lib/providers";
import { formatTokens } from "../lib/contextBudget";
import { toError } from "../lib/tauriBridge";

type ProvidersSettingsProps = {
  settings: AssistantSettings;
  onSave: (settings: AssistantSettings) => void;
};

type Filter = "all" | "connected" | ProviderCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "free", label: "Free" },
  { id: "router", label: "Routers" },
  { id: "trial", label: "Trial" },
  { id: "local", label: "Local" },
];

const CATEGORY_ORDER: ProviderCategory[] = ["free", "router", "trial", "local"];

const formatMs = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

const refKey = (ref: ModelRef) => `${ref.provider}\u0000${ref.model}`;

function parseRef(value: string): ModelRef | null {
  const [provider, model] = value.split("\u0000");
  return provider && model ? { provider, model } : null;
}

const button =
  "flex items-center gap-1.5 rounded-lg border border-ink/[0.09] bg-ink/[0.02] px-2.5 py-1.5 text-[11.5px] text-ink/60 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink disabled:pointer-events-none disabled:opacity-40";
const primary =
  "flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:pointer-events-none disabled:opacity-40";
const label =
  "block text-[10px] font-medium uppercase tracking-[0.18em] text-ink/35";

export default function ProvidersSettings({
  settings,
  onSave,
}: ProvidersSettingsProps) {
  const allIds = useMemo(
    () => [
      ...PROVIDERS.map((preset) => preset.id),
      ...settings.custom.map((custom) => custom.id),
    ],
    [settings.custom],
  );

  const [selected, setSelected] = useState<string>(
    () =>
      settings.chat?.provider ??
      allIds.find((id) => providerConnected(settings, id)) ??
      "nvidia",
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const connectedCount = allIds.filter((id) =>
    providerConnected(settings, id),
  ).length;

  const infos = useMemo(
    () =>
      allIds.flatMap((id) => {
        const info = providerInfo(settings, id);
        return info ? [info] : [];
      }),
    [allIds, settings],
  );

  const visible = infos.filter((info) => {
    const needle = query.trim().toLowerCase();

    if (
      needle &&
      !info.name.toLowerCase().includes(needle) &&
      !info.note.toLowerCase().includes(needle)
    ) {
      return false;
    }

    if (filter === "all") {
      return true;
    }

    if (filter === "connected") {
      return providerConnected(settings, info.id);
    }

    return info.category === filter && !info.custom;
  });

  const custom = visible.filter((info) => info.custom);
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: visible.filter(
      (info) => !info.custom && info.category === category,
    ),
  })).filter((group) => group.items.length > 0);

  const current = providerInfo(settings, selected);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="shrink-0 border-b border-line px-8 pt-8 pb-5">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-ink/90">
              AI providers
            </h1>
            <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-ink/40">
              Connect any OpenAI-compatible provider — free tiers, routers,
              trial credit or a model running on this machine — then pick
              which models the assistant uses.
            </p>
          </div>
          <span className="shrink-0 rounded-md border border-ink/[0.08] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-ink/40">
            {connectedCount} connected
          </span>
        </div>

        <DefaultModels settings={settings} onSave={onSave} />
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Providers"
          className="flex w-[280px] shrink-0 flex-col border-r border-line"
        >
          <div className="shrink-0 space-y-2 p-3">
            <div className="flex items-center gap-2 rounded-lg border border-line bg-ink/[0.02] px-2.5 py-1.5 focus-within:border-ink/25">
              <Search className="size-3.5 shrink-0 text-ink/30" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search providers"
                aria-label="Search providers"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink/25 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="text-ink/30 hover:text-ink"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  aria-pressed={filter === item.id}
                  className={`rounded-md px-2 py-0.5 text-[10.5px] transition-colors duration-150 ${
                    filter === item.id
                      ? "bg-ink/[0.09] text-ink/85"
                      : "text-ink/40 hover:bg-ink/[0.04] hover:text-ink/70"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {custom.length > 0 && (
              <ProviderGroup title="Custom">
                {custom.map((info) => (
                  <ProviderRow
                    key={info.id}
                    info={info}
                    settings={settings}
                    active={info.id === selected}
                    onSelect={() => setSelected(info.id)}
                  />
                ))}
              </ProviderGroup>
            )}
            {groups.map((group) => (
              <ProviderGroup
                key={group.category}
                title={
                  group.category === "free"
                    ? "Free tier"
                    : group.category === "router"
                      ? "Routers · one key, many models"
                      : group.category === "trial"
                        ? "Trial or one-time credit"
                        : "Local · on this machine"
                }
              >
                {group.items.map((info) => (
                  <ProviderRow
                    key={info.id}
                    info={info}
                    settings={settings}
                    active={info.id === selected}
                    onSelect={() => setSelected(info.id)}
                  />
                ))}
              </ProviderGroup>
            ))}
            {visible.length === 0 && (
              <p className="px-2 py-6 text-center text-[11.5px] text-ink/30">
                No providers match.
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-line p-3">
            {adding ? (
              <AddCustom
                onCancel={() => setAdding(false)}
                onAdd={(name, baseUrl, keyRequired) => {
                  const id = `custom-${Date.now().toString(36)}`;
                  onSave({
                    ...settings,
                    custom: [
                      ...settings.custom,
                      {
                        id,
                        name,
                        baseUrl,
                        key: keyRequired ? "required" : "optional",
                      },
                    ],
                  });
                  setAdding(false);
                  setFilter("all");
                  setSelected(id);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className={`${button} w-full justify-center`}
              >
                <Plus className="size-3.5" strokeWidth={2} />
                Add custom provider
              </button>
            )}
          </div>
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {current ? (
            <ProviderDetail
              key={current.id}
              info={current}
              settings={settings}
              onSave={onSave}
              onDeleted={() => setSelected("nvidia")}
            />
          ) : (
            <p className="p-8 text-[12px] text-ink/35">
              Pick a provider on the left.
            </p>
          )}
          <p className="px-8 pb-8 text-[10.5px] leading-relaxed text-ink/25">
            {SOURCE_NOTE}
          </p>
        </div>
      </div>
    </div>
  );
}

function ProviderGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <p className="px-2 pt-1 pb-1 text-[9.5px] uppercase tracking-[0.18em] text-ink/25">
        {title}
      </p>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function ProviderRow({
  info,
  settings,
  active,
  onSelect,
}: {
  info: ProviderInfo;
  settings: AssistantSettings;
  active: boolean;
  onSelect: () => void;
}) {
  const connected = providerConnected(settings, info.id);
  const ready = providerReady(settings, info.id);
  const needsUrl = !baseUrlFor(settings, info.id);
  const models = settings.providers[info.id]?.models.length ?? 0;
  const inUse = settings.chat?.provider === info.id;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 ${
          active
            ? "bg-ink/[0.08] text-ink"
            : "text-ink/60 hover:bg-ink/[0.04] hover:text-ink/85"
        }`}
      >
        <span
          title={
            connected
              ? "Connected"
              : ready
                ? "Ready — turn on a model"
                : "Not set up"
          }
          className={`size-1.5 shrink-0 rounded-full ${
            connected
              ? "bg-ink"
              : ready
                ? "ring-1 ring-ink/50"
                : "ring-1 ring-ink/15"
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px]">{info.name}</span>
        {inUse && (
          <span className="shrink-0 rounded bg-ink/[0.08] px-1 text-[9px] uppercase tracking-[0.1em] text-ink/60">
            in use
          </span>
        )}
        {connected ? (
          <span className="shrink-0 font-mono text-[10px] text-ink/35">
            {models}
          </span>
        ) : needsUrl ? (
          <span className="shrink-0 text-[9.5px] text-ink/25">needs URL</span>
        ) : info.key === "none" ? (
          <span className="shrink-0 text-[9.5px] text-ink/25">no key</span>
        ) : null}
      </button>
    </li>
  );
}

function AddCustom({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, baseUrl: string, keyRequired: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [keyRequired, setKeyRequired] = useState(true);
  const problem = url ? baseUrlProblem(url) : null;
  const canAdd = name.trim().length > 0 && url.trim().length > 0 && !problem;

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (canAdd) {
          onAdd(name.trim(), url.trim(), keyRequired);
        }
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name"
        aria-label="Provider name"
        className="w-full rounded-md border border-line bg-ink/[0.02] px-2 py-1.5 text-[12px] text-ink placeholder:text-ink/25 focus:border-ink/25 focus:outline-none"
      />
      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://api.example.com/v1"
        aria-label="Base URL"
        spellCheck={false}
        className="w-full rounded-md border border-line bg-ink/[0.02] px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-ink/25 focus:border-ink/25 focus:outline-none"
      />
      {problem && <p className="text-[10.5px] text-ink/55">{problem}</p>}
      <label className="flex items-center gap-1.5 text-[11px] text-ink/50">
        <input
          type="checkbox"
          checked={keyRequired}
          onChange={(event) => setKeyRequired(event.target.checked)}
          className="size-3 accent-ink"
        />
        Needs an API key
      </label>
      <div className="flex gap-1.5">
        <button type="submit" disabled={!canAdd} className={primary}>
          Add
        </button>
        <button type="button" onClick={onCancel} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DefaultModels({ settings, onSave }: ProvidersSettingsProps) {
  const options = modelOptions(settings);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
  }, [settings.chat]);

  const chatValid = options.some((option) => sameModel(option, settings.chat));
  const completionValid = options.some((option) =>
    sameModel(option, settings.completion),
  );

  const grouped = useMemo(() => {
    const map = new Map<string, typeof options>();

    for (const option of options) {
      map.set(option.providerName, [
        ...(map.get(option.providerName) ?? []),
        option,
      ]);
    }

    return [...map.entries()];
  }, [options]);

  const renderOptions = () =>
    grouped.map(([provider, items]) => (
      <optgroup key={provider} label={provider}>
        {items.map((option) => (
          <option key={refKey(option)} value={refKey(option)}>
            {option.model}
            {option.latency !== undefined ? ` · ${formatMs(option.latency)}` : ""}
          </option>
        ))}
      </optgroup>
    ));

  const select =
    "w-full min-w-0 rounded-lg border border-line bg-app px-2.5 py-1.5 font-mono text-[11.5px] text-ink/80 focus:border-ink/25 focus:outline-none disabled:opacity-40";

  const test = async () => {
    const target = targetFor(settings, settings.chat);

    if (!target) {
      return;
    }

    setTesting(true);
    setResult(null);

    try {
      const { reply, ms } = await pingModel(target);
      setResult(`Answered “${reply.slice(0, 40)}” in ${formatMs(ms)}.`);
    } catch (cause) {
      setResult(toError(cause, "The test failed.").message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mt-5 grid grid-cols-[1fr_1fr_auto] items-end gap-3 rounded-xl border border-line bg-ink/[0.015] p-4">
      <div className="min-w-0">
        <label htmlFor="chat-model" className={label}>
          Assistant model
        </label>
        <select
          id="chat-model"
          value={chatValid && settings.chat ? refKey(settings.chat) : ""}
          disabled={options.length === 0}
          onChange={(event) =>
            onSave({ ...settings, chat: parseRef(event.target.value) })
          }
          className={`${select} mt-2`}
        >
          {!chatValid && (
            <option value="">
              {options.length === 0
                ? "Connect a provider below"
                : "Choose a model"}
            </option>
          )}
          {renderOptions()}
        </select>
      </div>
      <div className="min-w-0">
        <label htmlFor="completion-model" className={label}>
          Inline completions
        </label>
        <select
          id="completion-model"
          value={
            completionValid && settings.completion
              ? refKey(settings.completion)
              : ""
          }
          disabled={options.length === 0}
          onChange={(event) =>
            onSave({ ...settings, completion: parseRef(event.target.value) })
          }
          className={`${select} mt-2`}
        >
          <option value="">Same as the assistant</option>
          {renderOptions()}
        </select>
      </div>
      <button
        type="button"
        onClick={() => void test()}
        disabled={!chatValid || testing}
        className={button}
        title="Send the assistant model a one-line test request"
      >
        {testing ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Gauge className="size-3.5" strokeWidth={1.75} />
        )}
        Test
      </button>
      {result && (
        <p className="col-span-3 -mt-1 text-[11px] text-ink/50">{result}</p>
      )}
      {!result && options.length > 0 && (
        <p className="col-span-3 -mt-1 text-[10.5px] text-ink/25">
          A small, fast model is best for inline completions; it is asked after
          every pause in typing.
        </p>
      )}
      {chatValid && settings.chat && (
        <ContextWindowField
          key={refKey(settings.chat)}
          settings={settings}
          chat={settings.chat}
          onSave={onSave}
        />
      )}
    </div>
  );
}

/**
 * How many tokens the assistant model accepts. Providers that report it fill
 * it in; for the rest (Ollama, LM Studio, many gateways) it is a cautious
 * default the user can correct, since the context meter and condensing plan
 * against it.
 */
function ContextWindowField({
  settings,
  chat,
  onSave,
}: ProvidersSettingsProps & { chat: ModelRef }) {
  const window = contextWindowFor(settings, chat);
  const [draft, setDraft] = useState(String(window.tokens));
  const state = settings.providers[chat.provider] ?? emptyProviderState;
  const parsed = Number(draft.replace(/[,_\s]/g, ""));
  const valid = Number.isInteger(parsed) && parsed >= 1024 && parsed <= 10_000_000;
  const changed = valid && parsed !== window.tokens;

  const save = (contextSet: Record<string, number>) =>
    onSave({
      ...settings,
      providers: {
        ...settings.providers,
        [chat.provider]: { ...state, contextSet },
      },
    });

  return (
    <div className="col-span-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3">
      <label htmlFor="context-window" className={label}>
        Context window
      </label>
      <input
        id="context-window"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && changed) {
            save({ ...state.contextSet, [chat.model]: parsed });
          }
        }}
        inputMode="numeric"
        spellCheck={false}
        aria-describedby="context-window-hint"
        className="w-28 rounded-md border border-line bg-app px-2 py-1 font-mono text-[11.5px] text-ink/80 focus:border-ink/25 focus:outline-none"
      />
      <span className="font-mono text-[10.5px] text-ink/35">tokens</span>
      {changed && (
        <button
          type="button"
          onClick={() => save({ ...state.contextSet, [chat.model]: parsed })}
          className={primary}
        >
          Save
        </button>
      )}
      {window.source === "set" && !changed && (
        <button
          type="button"
          onClick={() => {
            const contextSet = { ...state.contextSet };
            delete contextSet[chat.model];
            save(contextSet);
            setDraft(
              String(
                contextWindowFor(
                  {
                    ...settings,
                    providers: {
                      ...settings.providers,
                      [chat.provider]: { ...state, contextSet },
                    },
                  },
                  chat,
                ).tokens,
              ),
            );
          }}
          className={button}
        >
          <RotateCcw className="size-3.5" strokeWidth={1.75} />
          Use default
        </button>
      )}
      <p id="context-window-hint" className="basis-full text-[10.5px] text-ink/30">
        {!valid && draft.trim()
          ? "Enter a whole number of tokens, at least 1024."
          : window.source === "reported"
            ? `Reported by the provider for ${chat.model}.`
            : window.source === "set"
              ? `Set by you for ${chat.model}.`
              : `${chat.model} did not report its context window, so this is an assumption — set it to what the model (or your local server) actually allows.`}{" "}
        The assistant's context meter and condensing plan against this figure.
      </p>
    </div>
  );
}

function ProviderDetail({
  info,
  settings,
  onSave,
  onDeleted,
}: {
  info: ProviderInfo;
  settings: AssistantSettings;
  onSave: (settings: AssistantSettings) => void;
  onDeleted: () => void;
}) {
  const state: ProviderState = settings.providers[info.id] ?? emptyProviderState;
  const storedKey = settings.keys[info.id] ?? "";
  const [keyDraft, setKeyDraft] = useState(storedKey);
  const [showKey, setShowKey] = useState(false);
  // Keys arrive from the credential store after the first render.
  useEffect(() => {
    setKeyDraft(storedKey);
  }, [storedKey]);
  const [urlDraft, setUrlDraft] = useState(baseUrlFor(settings, info.id));
  const [busy, setBusy] = useState<null | "key" | "models" | "probe">(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [modelQuery, setModelQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);

  const urlProblem = baseUrlProblem(urlDraft);
  const urlChanged = urlDraft.trim() !== baseUrlFor(settings, info.id);
  const ready = providerReady(settings, info.id);
  const keyDirty = keyDraft.trim() !== storedKey.trim();

  const updateState = (
    patch: Partial<ProviderState>,
    extra: Partial<AssistantSettings> = {},
  ) =>
    onSave({
      ...settings,
      ...extra,
      providers: {
        ...settings.providers,
        [info.id]: { ...state, ...patch },
      },
    });

  const endpoint = () => ({
    name: info.name,
    baseUrl: baseUrlFor(settings, info.id),
    apiKey: settings.keys[info.id] ?? "",
  });

  const saveKey = async () => {
    setBusy("key");
    setMessage(null);

    try {
      await saveProviderKey(info.id, keyDraft.trim());
      const keys = { ...settings.keys };

      if (keyDraft.trim()) {
        keys[info.id] = keyDraft.trim();
      } else {
        delete keys[info.id];
      }

      onSave({ ...settings, keys });
      setMessage({
        text: keyDraft.trim()
          ? "Key saved to Windows Credential Manager. Load the models next."
          : "Key removed.",
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: toError(cause, "The key could not be saved.").message,
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const saveUrl = () => {
    if (urlProblem) {
      return;
    }

    const trimmed = urlDraft.trim();
    updateState({
      baseUrl: trimmed === info.defaultBaseUrl ? undefined : trimmed,
      catalogue: [],
    });
    setMessage({ text: "Base URL saved.", error: false });
  };

  const loadCatalogue = async () => {
    setBusy("models");
    setMessage(null);

    try {
      const listed = await listModels(endpoint());
      const catalogue = listed.map((model) => model.id);
      const contextWindows = Object.fromEntries(
        listed.flatMap((model) =>
          model.contextWindow ? [[model.id, model.contextWindow]] : [],
        ),
      );
      updateState({ catalogue, contextWindows, checkedAt: Date.now() });
      setMessage({
        text: `${catalogue.length} models listed. Turn on the ones you want in the assistant.`,
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: toError(cause, "The model list could not be loaded.").message,
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const probe = async (models: string[]) => {
    setBusy("probe");
    setMessage(null);

    try {
      const result = await probeModels(endpoint(), models);
      const failedCount = Object.keys(result.failed).length;
      updateState({
        latency: { ...state.latency, ...result.latency },
        checkedAt: Date.now(),
      });
      setMessage({
        text:
          failedCount === 0
            ? `All ${result.working.length} answered.`
            : `${result.working.length} answered, ${failedCount} did not: ${Object.entries(
                result.failed,
              )
                .slice(0, 2)
                .map(([model, why]) => `${model} — ${why}`)
                .join("; ")}`,
        error: failedCount > 0 && result.working.length === 0,
      });
    } catch (cause) {
      setMessage({
        text: toError(cause, "The models could not be tested.").message,
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleModel = (model: string) => {
    const on = state.models.includes(model);
    const models = on
      ? state.models.filter((id) => id !== model)
      : [...state.models, model];
    const ref = { provider: info.id, model };
    const extra: Partial<AssistantSettings> = {};

    if (!on && !settings.chat) {
      extra.chat = ref;
    }

    if (on && sameModel(settings.chat, ref)) {
      const next = models[0];
      extra.chat = next ? { provider: info.id, model: next } : null;
    }

    if (on && sameModel(settings.completion, ref)) {
      extra.completion = null;
    }

    updateState({ models }, extra);
  };

  const catalogue = useMemo(() => {
    const all = [...new Set([...state.models, ...state.catalogue])].sort(
      (a, b) =>
        Number(state.models.includes(b)) - Number(state.models.includes(a)) ||
        a.localeCompare(b),
    );
    const needle = modelQuery.trim().toLowerCase();

    return all.filter(
      (model) =>
        (!needle || model.toLowerCase().includes(needle)) &&
        (!freeOnly || model.endsWith(":free") || state.models.includes(model)),
    );
  }, [state.models, state.catalogue, modelQuery, freeOnly]);

  const hasFreeTag = state.catalogue.some((model) => model.endsWith(":free"));
  const [manual, setManual] = useState("");

  return (
    <div className="max-w-[760px] px-8 py-7">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink/90">
              {info.name}
            </h2>
            <span className="shrink-0 rounded border border-ink/[0.1] px-1.5 py-px text-[9.5px] uppercase tracking-[0.12em] text-ink/40">
              {info.custom ? "Custom" : CATEGORY_LABEL[info.category]}
            </span>
            {providerConnected(settings, info.id) && (
              <span className="flex shrink-0 items-center gap-1 text-[9.5px] uppercase tracking-[0.12em] text-ink/55">
                <CircleDot className="size-3" strokeWidth={2} />
                Connected
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink/45">
            {info.note}
          </p>
          {info.caution && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink/50">
              <AlertTriangle
                className="mt-0.5 size-3 shrink-0"
                strokeWidth={1.75}
              />
              {info.caution}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {info.docsUrl && (
            <a
              href={info.docsUrl}
              target="_blank"
              rel="noreferrer"
              className={button}
            >
              {info.key === "none" ? "Website" : "Get a key"}
              <ExternalLink className="size-3" strokeWidth={1.75} />
            </a>
          )}
          {info.custom && (
            <button
              type="button"
              onClick={() => {
                void saveProviderKey(info.id, "").catch(() => {});
                const providers = { ...settings.providers };
                const keys = { ...settings.keys };
                delete providers[info.id];
                delete keys[info.id];
                onSave({
                  ...settings,
                  providers,
                  keys,
                  custom: settings.custom.filter(
                    (custom) => custom.id !== info.id,
                  ),
                  chat:
                    settings.chat?.provider === info.id ? null : settings.chat,
                  completion:
                    settings.completion?.provider === info.id
                      ? null
                      : settings.completion,
                });
                onDeleted();
              }}
              className={button}
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
              Remove
            </button>
          )}
        </div>
      </div>

      <section className="mt-6 space-y-5 rounded-xl border border-line bg-ink/[0.015] p-5">
        {info.key !== "none" && (
          <div>
            <label htmlFor="provider-key" className={label}>
              API key
              {info.key === "optional" && (
                <span className="ml-2 normal-case tracking-normal text-ink/30">
                  optional — works without one at lower limits
                </span>
              )}
            </label>
            <div className="mt-2 flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-app px-3 py-1.5 focus-within:border-ink/25">
                <KeyRound className="size-3.5 shrink-0 text-ink/30" />
                <input
                  id="provider-key"
                  type={showKey ? "text" : "password"}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && keyDirty) {
                      void saveKey();
                    }
                  }}
                  placeholder={storedKey ? "" : "Paste your key"}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink placeholder:text-ink/20 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((visible) => !visible)}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  className="flex size-6 items-center justify-center rounded text-ink/30 hover:bg-ink/[0.06] hover:text-ink"
                >
                  {showKey ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={!keyDirty || busy !== null}
                className={primary}
              >
                {busy === "key" && <LoaderCircle className="size-3.5 animate-spin" />}
                {keyDraft.trim() || !storedKey ? "Save key" : "Remove key"}
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] text-ink/30">
              Stored in Windows Credential Manager, never in a file. Sent only
              to this provider's base URL.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="provider-url" className={label}>
            Base URL
          </label>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-app px-3 py-1.5 focus-within:border-ink/25">
              <Link2 className="size-3.5 shrink-0 text-ink/30" />
              <input
                id="provider-url"
                value={urlDraft}
                onChange={(event) => setUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && urlChanged) {
                    saveUrl();
                  }
                }}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink placeholder:text-ink/20 focus:outline-none"
              />
            </div>
            {urlChanged && (
              <button
                type="button"
                onClick={saveUrl}
                disabled={Boolean(urlProblem)}
                className={primary}
              >
                Save URL
              </button>
            )}
            {!info.custom &&
              state.baseUrl &&
              info.defaultBaseUrl &&
              !urlChanged && (
                <button
                  type="button"
                  onClick={() => {
                    setUrlDraft(info.defaultBaseUrl ?? "");
                    updateState({ baseUrl: undefined, catalogue: [] });
                  }}
                  className={button}
                  title="Go back to the built-in URL"
                >
                  <RotateCcw className="size-3.5" strokeWidth={1.75} />
                  Reset
                </button>
              )}
          </div>
          <p className="mt-1.5 text-[10.5px] text-ink/30">
            {urlDraft.trim() && urlProblem
              ? urlProblem
              : info.defaultBaseUrl
                ? "The OpenAI-compatible endpoint, ending before /chat/completions."
                : "This provider has no built-in URL. Copy its OpenAI-compatible base URL from its docs."}
          </p>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-ink/[0.015] p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[12.5px] font-semibold text-ink/80">Models</h3>
            <p className="mt-0.5 text-[10.5px] text-ink/30">
              {state.models.length} on
              {state.catalogue.length > 0
                ? ` · ${state.catalogue.length} listed`
                : ""}
              {state.checkedAt
                ? ` · checked ${new Date(state.checkedAt).toLocaleString()}`
                : ""}
            </p>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => void probe(state.models)}
              disabled={!ready || state.models.length === 0 || busy !== null}
              className={button}
              title="Send each turned-on model a one-token request and time it"
            >
              {busy === "probe" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Gauge className="size-3.5" strokeWidth={1.75} />
              )}
              Test models
            </button>
            <button
              type="button"
              onClick={() => void loadCatalogue()}
              disabled={!ready || busy !== null}
              className={primary}
            >
              {busy === "models" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={2} />
              )}
              {state.catalogue.length > 0 ? "Reload list" : "Load models"}
            </button>
          </div>
        </div>

        {message && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
              message.error
                ? "border border-ink/15 bg-ink/[0.05] text-ink/75"
                : "text-ink/50"
            }`}
          >
            {message.text}
          </p>
        )}

        {!ready ? (
          <p className="mt-4 rounded-lg border border-dashed border-ink/[0.09] px-4 py-6 text-center text-[11.5px] text-ink/30">
            {!baseUrlFor(settings, info.id)
              ? "Add a base URL to list this provider's models."
              : "Save an API key to list this provider's models."}
          </p>
        ) : (
          <>
            <div className="mt-4 flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-app px-2.5 py-1.5 focus-within:border-ink/25">
                <Search className="size-3.5 shrink-0 text-ink/30" />
                <input
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder="Filter models"
                  aria-label="Filter models"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink placeholder:text-ink/25 focus:outline-none"
                />
              </div>
              {hasFreeTag && (
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink/50">
                  <input
                    type="checkbox"
                    checked={freeOnly}
                    onChange={(event) => setFreeOnly(event.target.checked)}
                    className="size-3 accent-ink"
                  />
                  :free only
                </label>
              )}
            </div>

            {catalogue.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-ink/[0.09] px-4 py-6 text-center text-[11.5px] text-ink/30">
                {state.catalogue.length === 0
                  ? "Load the model list, or add a model id by hand below."
                  : "No models match the filter."}
              </p>
            ) : (
              <ul className="mt-3 max-h-[340px] space-y-px overflow-y-auto rounded-lg border border-ink/[0.06] p-1">
                {catalogue.slice(0, 500).map((model) => {
                  const on = state.models.includes(model);
                  const ms = state.latency[model];
                  const context = state.contextWindows[model];
                  const isChat = sameModel(settings.chat, {
                    provider: info.id,
                    model,
                  });

                  return (
                    <li key={model}>
                      <label
                        className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-100 ${
                          on ? "bg-ink/[0.05]" : "hover:bg-ink/[0.03]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleModel(model)}
                          className="size-3 shrink-0 accent-ink"
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
                            on ? "text-ink/85" : "text-ink/50"
                          }`}
                        >
                          {model}
                        </span>
                        {isChat && (
                          <span className="shrink-0 rounded bg-ink/[0.08] px-1 text-[9px] uppercase tracking-[0.1em] text-ink/60">
                            assistant
                          </span>
                        )}
                        {context !== undefined && (
                          <span
                            title={`${context.toLocaleString()} tokens of context`}
                            className="shrink-0 font-mono text-[10px] text-ink/30"
                          >
                            {formatTokens(context)}
                          </span>
                        )}
                        {ms !== undefined && (
                          <span className="shrink-0 font-mono text-[10px] text-ink/35">
                            {formatMs(ms)}
                          </span>
                        )}
                        {on && !isChat && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              onSave({
                                ...settings,
                                chat: { provider: info.id, model },
                              });
                            }}
                            className="shrink-0 rounded px-1 text-[10px] text-ink/35 hover:bg-ink/[0.07] hover:text-ink"
                            title="Make this the assistant's model"
                          >
                            use
                          </button>
                        )}
                        {on && isChat && (
                          <Check className="size-3 shrink-0 text-ink/60" />
                        )}
                      </label>
                    </li>
                  );
                })}
                {catalogue.length > 500 && (
                  <li className="px-2 py-1.5 text-[10.5px] text-ink/30">
                    {catalogue.length - 500} more — filter to find them.
                  </li>
                )}
              </ul>
            )}

            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const id = manual.trim();

                if (id && !state.models.includes(id)) {
                  toggleModel(id);
                }

                setManual("");
              }}
            >
              <input
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                placeholder="Add a model id by hand"
                aria-label="Model id"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-line bg-app px-2.5 py-1.5 font-mono text-[11.5px] text-ink placeholder:text-ink/25 focus:border-ink/25 focus:outline-none"
              />
              <button type="submit" disabled={!manual.trim()} className={button}>
                <Plus className="size-3.5" strokeWidth={2} />
                Add
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
