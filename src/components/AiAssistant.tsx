import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  File,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Settings2,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AgentStep } from "../lib/nim";
import MarkdownMessage from "./MarkdownMessage";

export type AssistantMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  reasoning?: string | null;
  steps?: AgentStep[];
};

type AiAssistantProps = {
  messages: AssistantMessage[];
  configured: boolean;
  model: string;
  pending: boolean;
  live: { steps: AgentStep[]; reasoning: string; text: string } | null;
  contextPath: string | null;
  models: string[];
  latency: Record<string, number>;
  onSelectModel: (id: string) => void;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  /** Chat-only mode: the panel fills the window instead of the side rail. */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSend: (text: string) => void;
  /** A prompt handed over by a right-click action; it fills the composer once. */
  seed: string | null;
  onSeedConsumed: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onHide: () => void;
};

export default function AiAssistant({
  messages,
  configured,
  model,
  pending,
  live,
  contextPath,
  models,
  latency,
  onSelectModel,
  explorerOpen,
  onToggleExplorer,
  fullscreen,
  onToggleFullscreen,
  onSend,
  seed,
  onSeedConsumed,
  onStop,
  onOpenSettings,
  onHide,
}: AiAssistantProps) {
  const full = fullscreen;
  const [prompt, setPrompt] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // A right-click on code hands the composer a ready prompt: it replaces the
  // draft, takes focus and leaves the caret at the end, ready to edit or send.
  useEffect(() => {
    if (seed === null) {
      return;
    }

    setPrompt(seed);
    onSeedConsumed();

    const node = promptRef.current;

    if (node && !node.disabled) {
      node.focus();
      node.setSelectionRange(seed.length, seed.length);
      node.scrollTop = node.scrollHeight;
    }
  }, [seed, onSeedConsumed]);

  // Close the model list on an outside click or Escape (captured so the
  // full-screen Escape handler does not also fire).
  useEffect(() => {
    if (!switcherOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setSwitcherOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [switcherOpen]);

  /** While this is true the transcript stays pinned to the newest token. */
  const followRef = useRef(true);

  /** The jump-to-latest button only appears once the newest message is off-screen. */
  const updateAtBottom = () => {
    const node = scrollRef.current;

    if (!node) {
      return;
    }

    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 48;

    followRef.current = nearBottom;
    setAtBottom(nearBottom);
  };

  const scrollToBottom = () => {
    followRef.current = true;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  // Streamed tokens arrive as new `live` objects, so this runs on every token
  // and keeps the newest text in view — unless the reader scrolled up, in which
  // case following pauses until they return to the bottom.
  useEffect(() => {
    const node = scrollRef.current;

    if (!node || !followRef.current) {
      return;
    }

    node.scrollTop = node.scrollHeight;
    setAtBottom(true);
  }, [messages, pending, live]);

  const canSend = configured && !pending && prompt.trim().length > 0;

  const submit = () => {
    if (!canSend) {
      return;
    }

    onSend(prompt.trim());
    setPrompt("");
  };

  return (
    <aside
      aria-label="AI Assistant"
      className={
        full
          ? "flex min-w-0 flex-1 flex-col bg-app"
          : "flex w-[340px] shrink-0 flex-col border-l border-line bg-surface"
      }
    >
      <div
        className={`flex shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent ${full ? "h-11 px-4" : "h-9 px-3"}`}
      >
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/45">
          <Sparkles
            className="size-3.5 shrink-0 text-ink/55"
            strokeWidth={1.75}
          />
          Assistant
        </span>
        <span className="flex items-center gap-0.5">
          {full && (
            <button
              type="button"
              onClick={onToggleExplorer}
              aria-pressed={explorerOpen}
              aria-label={explorerOpen ? "Hide explorer" : "Show explorer"}
              title={explorerOpen ? "Hide explorer" : "Show explorer"}
              className={`flex size-6 items-center justify-center rounded-md transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink ${
                explorerOpen ? "bg-ink/[0.06] text-ink/70" : "text-ink/30"
              }`}
            >
              {explorerOpen ? (
                <PanelLeftClose className="size-3.5" strokeWidth={1.75} />
              ) : (
                <PanelLeftOpen className="size-3.5" strokeWidth={1.75} />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={full ? "Exit full screen" : "Full screen assistant"}
            title={full ? "Exit full screen (Esc)" : "Full screen assistant"}
            className="flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
          >
            {full ? (
              <Minimize2 className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Maximize2 className="size-3.5" strokeWidth={1.75} />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
          >
            <Settings2 className="size-3.5" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={onHide}
            aria-label="Hide AI assistant"
            title="Hide AI assistant"
            className="flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
          >
            <PanelRightClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={updateAtBottom}
          className={`min-h-0 flex-1 overflow-y-auto ${full ? "px-6 py-6" : "px-3.5 py-4"}`}
        >
        <div className={full ? "mx-auto w-full max-w-[760px]" : undefined}>
        {!configured ? (
          <div
            className={`flex flex-col items-center gap-3.5 text-center ${full ? "mt-32" : "mt-12"}`}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.03] ring-1 ring-ink/[0.08] ring-inset">
              <Sparkles className="size-4 text-ink/30" strokeWidth={1.5} />
            </span>
            <div>
              <p className="text-[12.5px] text-ink/55">
                NVIDIA NIM is not connected
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink/30">
                Add an API key to let the assistant read and edit this
                workspace.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
            >
              Open settings
            </button>
          </div>
        ) : messages.length === 0 && !pending ? (
          <div
            className={`flex flex-col items-center gap-3 text-center ${full ? "mt-32" : "mt-12"}`}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.03] ring-1 ring-ink/[0.08] ring-inset">
              <Sparkles className="size-4 text-ink/25" strokeWidth={1.5} />
            </span>
            <p className="text-[12px] leading-relaxed text-ink/35">
              Ask about the files in this workspace, or anything else.
            </p>
          </div>
        ) : (
          <ul className="space-y-5">
            {messages.map((message) => (
              <li key={message.id} className="text-[13px] leading-relaxed">
                <p className="mb-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25">
                  {message.role === "user" ? "You" : "Assistant"}
                </p>
                {message.role === "user" ? (
                  <div
                    className={`rounded-xl border border-ink/[0.07] bg-ink/[0.04] leading-relaxed whitespace-pre-wrap text-ink/80 ${
                      full ? "px-3.5 py-2.5 text-[13px]" : "px-3 py-2 text-[12.5px]"
                    }`}
                  >
                    {message.text}
                  </div>
                ) : message.error ? (
                  <p className="whitespace-pre-wrap rounded-lg border border-ink/[0.06] bg-ink/[0.02] px-3 py-2 text-[12.5px] leading-relaxed text-ink/45">
                    {message.text}
                  </p>
                ) : (
                  <MarkdownMessage text={message.text} large={full} />
                )}

                {message.reasoning && (
                  <details className="mt-2">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25 transition-colors duration-150 hover:text-ink/55">
                      <Brain className="size-3" strokeWidth={1.75} />
                      Thinking
                    </summary>
                    <p className="mt-1.5 whitespace-pre-wrap border-l border-ink/[0.07] pl-2.5 text-[11px] leading-relaxed text-ink/35">
                      {message.reasoning}
                    </p>
                  </details>
                )}

                {message.steps && message.steps.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25 transition-colors duration-150 hover:text-ink/55">
                      <Wrench className="size-3" strokeWidth={1.75} />
                      {message.steps.length}{" "}
                      {message.steps.length === 1 ? "step" : "steps"}
                    </summary>
                    <ul className="mt-1.5 space-y-1.5 border-l border-ink/[0.07] pl-2.5">
                      {message.steps.map((step) => (
                        <li
                          key={`${message.id}-${step.id}`}
                          className="flex items-start gap-1.5 text-[11px] leading-relaxed"
                        >
                          <Check
                            className={`mt-0.5 size-3 shrink-0 ${
                              step.kind === "error"
                                ? "text-ink/25"
                                : "text-ink/50"
                            }`}
                          />
                          <span className="min-w-0">
                            <span className="text-ink/50">{step.title}</span>
                            {step.detail && (
                              <span className="block truncate font-mono text-[10px] text-ink/25">
                                {step.detail}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
            {pending && (
              <li className="text-[13px] leading-relaxed">
                <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-ink/30">
                  Assistant
                </p>
                <LiveRun live={live} model={model} large={full} />
              </li>
            )}
          </ul>
        )}
        </div>
        </div>

        {!atBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-ink/[0.12] bg-raised/95 text-ink/60 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.95)] backdrop-blur transition-colors duration-150 hover:border-ink/25 hover:text-ink"
          >
            <ChevronDown className="size-4" strokeWidth={2} />
          </button>
        )}
      </div>

      <div
        className={`shrink-0 border-t border-line ${full ? "px-6 py-4" : "p-3"}`}
      >
        <div className={full ? "mx-auto w-full max-w-[760px]" : undefined}>
        {contextPath && (
          <div
            title={`The assistant reads ${contextPath}`}
            className="mb-2 flex items-center gap-1.5 rounded-md border border-ink/[0.07] bg-ink/[0.02] px-2 py-1 text-[10px] text-ink/35"
          >
            <File className="size-3 shrink-0 text-ink/25" strokeWidth={1.75} />
            <span className="truncate font-mono">{contextPath}</span>
          </div>
        )}
        <div className="rounded-xl border border-ink/[0.08] bg-ink/[0.03] transition-colors duration-150 focus-within:border-ink/20 focus-within:bg-ink/[0.045]">
          {configured && (
            <div
              ref={switcherRef}
              className="relative flex items-center border-b border-ink/[0.05] px-2 py-2"
            >
              <button
                type="button"
                onClick={() => setSwitcherOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={switcherOpen}
                aria-label={`Model: ${model}. Change model`}
                title={switcherOpen ? "Close model list" : "Change model"}
                className={`flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 transition-colors duration-150 ${
                  switcherOpen
                    ? "border-ink/20 bg-ink/[0.07] text-ink/80"
                    : "border-ink/[0.07] bg-ink/[0.02] text-ink/45 hover:border-ink/15 hover:text-ink/70"
                }`}
              >
                <Cpu className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 max-w-[11rem] truncate font-mono text-[10px]">
                  {model}
                </span>
                <ChevronDown
                  className={`size-3 shrink-0 transition-transform duration-150 ${
                    switcherOpen ? "rotate-180" : ""
                  }`}
                  strokeWidth={2}
                />
              </button>

              {switcherOpen && (
                <div
                  role="listbox"
                  aria-label="Model"
                  className="absolute bottom-full left-2 z-30 mb-2 max-h-64 w-[286px] max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-ink/[0.09] bg-raised/95 p-1 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
                >
                  {models.length === 0 ? (
                    <p className="px-2.5 py-2 text-[11px] leading-relaxed text-ink/35">
                      No verified models yet. Verify your key in Settings.
                    </p>
                  ) : (
                    models.map((id) => {
                      const selected = id === model;
                      const ms = latency[id];

                      return (
                        <button
                          key={id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            onSelectModel(id);
                            setSwitcherOpen(false);
                          }}
                          className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors duration-100 ${
                            selected
                              ? "bg-ink/[0.07] text-ink"
                              : "text-ink/60 hover:bg-ink/[0.05] hover:text-ink/90"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                            {id}
                          </span>
                          {ms !== undefined && (
                            <span className="shrink-0 font-mono text-[9.5px] text-ink/25">
                              {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
                            </span>
                          )}
                          {selected && (
                            <Check
                              className="size-3 shrink-0 text-ink"
                              strokeWidth={2.5}
                            />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            disabled={!configured || pending}
            placeholder={
              configured ? "Ask the assistant…" : "Connect a model in Settings"
            }
            aria-label="Message the assistant"
            className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink placeholder:text-ink/25 focus:outline-none disabled:cursor-not-allowed disabled:text-ink/30"
          />
          <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-2">
            <span className="truncate text-[9.5px] text-ink/25">
              Enter to send · Shift+Enter for newline
            </span>
            {pending ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop the assistant"
                title="Stop the assistant"
                className="flex size-7 items-center justify-center rounded-lg border border-ink/15 text-ink/60 transition-colors duration-150 hover:border-ink/40 hover:bg-ink/[0.06] hover:text-ink"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                className="flex size-7 items-center justify-center rounded-lg bg-ink text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/10 disabled:text-ink/30"
              >
                <ArrowUp className="size-3.5" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </aside>
  );
}

type LiveRunProps = {
  live: { steps: AgentStep[]; reasoning: string; text: string } | null;
  model: string;
  large: boolean;
};

function LiveRun({ live, model, large }: LiveRunProps) {
  const [seconds, setSeconds] = useState(0);
  const started = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started.current) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const steps = live?.steps ?? [];
  const reasoning = live?.reasoning ?? "";
  const text = live?.text ?? "";

  return (
    <div className="space-y-2">
      {steps.length > 0 && (
        <ul className="space-y-1.5 border-l border-ink/[0.07] pl-2.5">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-start gap-1.5 text-[11px] leading-relaxed"
            >
              {step.status === "running" ? (
                <LoaderCircle className="mt-0.5 size-3 shrink-0 animate-spin text-ink/45" />
              ) : (
                <Check
                  className={`mt-0.5 size-3 shrink-0 ${
                    step.kind === "error" ? "text-ink/25" : "text-ink/50"
                  }`}
                />
              )}
              <span className="min-w-0">
                <span
                  className={
                    step.status === "running" ? "text-ink/65" : "text-ink/45"
                  }
                >
                  {step.title}
                </span>
                {step.detail && (
                  <span className="block truncate font-mono text-[10px] text-ink/25">
                    {step.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {reasoning.length > 0 && (
        <div className="border-l border-ink/[0.07] pl-2.5">
          <p className="mb-1 flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25">
            <Brain className="size-3" strokeWidth={1.75} />
            Thinking
          </p>
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink/35">
            {reasoning}
          </p>
        </div>
      )}

      {text.length > 0 ? (
        <MarkdownMessage text={text} caret large={large} />
      ) : (
        <div className="space-y-1">
          <p className="text-[11px] text-ink/40">
            {model ? `Waiting for ${model}` : "Thinking"}… {seconds}s
          </p>
          {seconds >= 20 && (
            <p className="text-[10px] leading-relaxed text-ink/25">
              Large models can take a minute or more before the first token.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
