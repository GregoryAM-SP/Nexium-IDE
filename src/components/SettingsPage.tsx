import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { AssistantSettings } from "../lib/assistantSettings";
import { emptyAssistantSettings } from "../lib/assistantSettings";
import { pingModel, verifyModelsForKey } from "../lib/nim";
import type { VerificationProgress } from "../lib/nim";
import { toError } from "../lib/tauriBridge";

type SettingsPageProps = {
  settings: AssistantSettings;
  onSave: (settings: AssistantSettings) => void;
};

type Phase = "idle" | "listing" | "probing";

function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function verifiedLabel(verifiedAt: number | null): string {
  if (!verifiedAt) {
    return "Not verified yet.";
  }

  return `Last verified ${new Date(verifiedAt).toLocaleString()}.`;
}

export default function SettingsPage({
  settings,
  onSave,
}: SettingsPageProps) {
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  // The stored key arrives from the credential store after the first render.
  useEffect(() => {
    setApiKey(settings.apiKey);
  }, [settings.apiKey]);
  const [model, setModel] = useState(settings.model);
  const [workingModels, setWorkingModels] = useState<string[]>(
    settings.workingModels,
  );
  const [verifiedAt, setVerifiedAt] = useState<number | null>(
    settings.verifiedAt,
  );
  const [timings, setTimings] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<VerificationProgress>({
    done: 0,
    total: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const busy = phase !== "idle";
  const configured = Boolean(settings.apiKey && settings.model);

  const verify = async () => {
    const key = apiKey.trim();

    if (!key) {
      setError("Enter your NVIDIA API key first.");
      return;
    }

    setError(null);
    setNotice(null);
    setPhase("listing");

    try {
      setPhase("probing");
      setProgress({ done: 0, total: 0 });

      const result = await verifyModelsForKey(key, setProgress);
      const working = result.working;

      const nextModel = working.includes(model) ? model : (working[0] ?? "");
      const stamp = Date.now();

      setWorkingModels(working);
      setTimings(result.latency ?? {});
      setModel(nextModel);
      setVerifiedAt(stamp);
      onSave({
        apiKey: key,
        model: nextModel,
        workingModels: working,
        latency: result.latency ?? {},
        verifiedAt: stamp,
      });

      setNotice(
        working.length > 0
          ? `${working.length} of ${result.total} listed models answered a test request.`
          : "No model answered a test request. Check the key or try again later.",
      );
    } catch (cause) {
      setError(toError(cause, "Model verification failed.").message);
    } finally {
      setPhase("idle");
    }
  };

  const testConnection = async () => {
    if (!settings.apiKey || !settings.model) {
      setError("Save your key and choose a model first.");
      return;
    }

    setError(null);
    setNotice(null);
    setTesting(true);

    try {
      const reply = await pingModel(settings.apiKey, settings.model);
      setNotice(`Model answered: ${reply.slice(0, 80)}`);
    } catch (cause) {
      setError(toError(cause, "The connection test failed.").message);
    } finally {
      setTesting(false);
    }
  };

  const selectModel = (id: string) => {
    setModel(id);
    // Keep the key that was actually verified, not a half-edited draft.
    onSave({
      apiKey: settings.apiKey,
      model: id,
      workingModels,
      latency: settings.latency,
      verifiedAt,
    });
  };

  const removeKey = () => {
    setApiKey("");
    setModel("");
    setWorkingModels([]);
    setTimings({});
    setVerifiedAt(null);
    setError(null);
    setNotice(null);
    onSave({ ...emptyAssistantSettings });
  };

  return (
    <div className="h-full overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[720px] px-10 py-12">
        <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-ink/90">
          AI assistant
        </h1>
        <p className="mt-1.5 max-w-[52ch] text-[12px] leading-relaxed text-ink/40">
          Connect NVIDIA NIM so the assistant can read and edit the folder you
          have open.
        </p>

        <section className="mt-8 rounded-2xl border border-line bg-ink/[0.015] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[12.5px] font-semibold text-ink/80">
                Connection
              </h2>
              <p className="mt-1 font-mono text-[10.5px] text-ink/30">
                NVIDIA NIM · integrate.api.nvidia.com/v1
              </p>
            </div>
            <a
              href="https://build.nvidia.com/settings/api-keys"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-ink/[0.09] bg-ink/[0.02] px-2.5 py-1.5 text-[11.5px] text-ink/55 transition-colors duration-150 hover:border-ink/20 hover:text-ink"
            >
              Get an API key
              <ExternalLink className="size-3" strokeWidth={1.75} />
            </a>
          </div>

          <label
            htmlFor="nim-api-key"
            className="mt-6 block text-[10px] font-medium uppercase tracking-[0.18em] text-ink/35"
          >
            API key
          </label>
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-app px-3 py-2 transition-colors duration-150 focus-within:border-ink/25">
            <KeyRound className="size-3.5 shrink-0 text-ink/30" />
            <input
              id="nim-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="nvapi-…"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:text-ink/20 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowKey((visible) => !visible)}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              title={showKey ? "Hide API key" : "Show API key"}
              className="flex size-6 items-center justify-center rounded text-ink/30 transition hover:bg-ink/[0.06] hover:text-ink"
            >
              {showKey ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink/30">
            Kept in this browser's local storage and sent only to NVIDIA through
            the local proxy. Never commit it to the repository.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={verify}
              disabled={busy}
              className="flex items-center gap-2 rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/15 disabled:text-ink/40"
            >
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {busy ? "Verifying…" : "Save key & verify models"}
            </button>
            <button
              type="button"
              onClick={testConnection}
              disabled={busy || testing || !configured}
              className="flex items-center gap-2 rounded-lg border border-ink/[0.09] bg-ink/[0.02] px-3 py-1.5 text-[11.5px] text-ink/55 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink disabled:border-ink/5 disabled:bg-transparent disabled:text-ink/20"
            >
              {testing && <LoaderCircle className="size-3.5 animate-spin" />}
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              type="button"
              onClick={removeKey}
              disabled={busy || (!apiKey && workingModels.length === 0)}
              className="rounded-lg border border-ink/[0.09] bg-ink/[0.02] px-3 py-1.5 text-[11.5px] text-ink/55 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink disabled:border-ink/5 disabled:bg-transparent disabled:text-ink/20"
            >
              Remove key
            </button>
            {configured && (
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-ink/35">
                <ShieldCheck className="size-3.5" strokeWidth={1.75} />
                Connected
              </span>
            )}
          </div>

          {busy && (
            <p className="mt-3 text-[11px] text-ink/45">
              {phase === "listing"
                ? "Fetching the NVIDIA model catalogue…"
                : progress.total > 0
                  ? `Testing models: ${progress.done} of ${progress.total}…`
                  : "Testing every model with a live request…"}
            </p>
          )}
          {notice && !busy && (
            <p className="mt-3 text-[11px] text-ink/50">{notice}</p>
          )}
          {error && (
            <p className="mt-3 text-[11px] leading-relaxed text-ink/70">
              {error}
            </p>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-ink/[0.015] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[12.5px] font-semibold text-ink/80">
                Models
              </h2>
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">
                Only models that answered a live chat request with your key are
                listed. Everything else in the catalogue is hidden.
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-ink/25">
                Sorted by how fast each model answered its test request. Very
                large models (550B+) can spend minutes on one answer; if the
                chosen model stalls, the assistant retries once with the
                fastest verified model.
              </p>
            </div>
            <span className="shrink-0 rounded border border-ink/[0.07] px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.12em] text-ink/30">
              {workingModels.length} working
            </span>
          </div>

          {workingModels.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-ink/[0.09] px-4 py-8 text-center text-[11.5px] text-ink/30">
              No verified models yet — save your key and verify to fill this
              list.
            </p>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {workingModels.map((id) => {
                const selected = id === model;

                return (
                  <li key={id}>
                    <label
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-100 focus-within:border-ink/40 ${
                        selected
                          ? "border-ink/25 bg-ink/[0.06]"
                          : "border-ink/[0.07] hover:border-ink/15 hover:bg-ink/[0.03]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="radio"
                          name="nim-model"
                          checked={selected}
                          onChange={() => selectModel(id)}
                          className="size-3 shrink-0 accent-ink"
                        />
                        <span className="truncate font-mono text-[11.5px] text-ink/75">
                          {id}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {timings[id] !== undefined && (
                          <span className="font-mono text-[10px] text-ink/30">
                            {formatLatency(timings[id])}
                          </span>
                        )}
                        {selected && (
                          <Check className="size-3.5 shrink-0 text-ink" />
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-4 text-[11px] text-ink/25">
            {verifiedLabel(verifiedAt)}
          </p>
        </section>

      </div>
    </div>
  );
}
