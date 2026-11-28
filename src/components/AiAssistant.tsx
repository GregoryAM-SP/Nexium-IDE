import {
  ArrowUp,
  Ban,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  Copy,
  Cpu,
  File,
  FilePen,
  FilePlus,
  FileText,
  FolderTree,
  Info,
  ListChecks,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Play,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Square,
  Wrench,
  X,
  Zap,
  Layers,
  ListPlus,
  Archive,
  ArchiveRestore,
  History,
  Pencil,
  Send,
  SquareTerminal,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { mergeBlocks, objectivesOf } from "../lib/assistantMessages";
import type { AssistantMessage, MessageBlock } from "../lib/assistantMessages";
import { sameModel } from "../lib/assistantSettings";
import type { ModelOption, ModelRef } from "../lib/assistantSettings";
import { estimateTokens, formatTokens } from "../lib/contextBudget";
import type { CondensedHistory } from "../lib/contextBudget";
import { lineDiff } from "../lib/lineDiff";
import type { AgentStep, ApprovalRequest, Objective, RunActivity } from "../lib/llm";
import MarkdownMessage from "./MarkdownMessage";
import { UNTITLED } from "../lib/sessions";
import type { SessionSummary } from "../lib/sessions";

export type { AssistantMessage } from "../lib/assistantMessages";

type AiAssistantProps = {
  messages: AssistantMessage[];
  configured: boolean;
  /** The model the assistant is using, if one is set up. */
  model: ModelRef | null;
  pending: boolean;
  live: { blocks: MessageBlock[]; activity?: RunActivity | null } | null;
  contextPath: string | null;
  /** Every turned-on model of every connected provider. */
  models: ModelOption[];
  onSelectModel: (ref: ModelRef) => void;
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
  /** Changes the agent proposed that wait on Accept/Reject, by step id. */
  approvals: Record<number, ApprovalRequest>;
  onDecide: (stepId: number, accept: boolean) => void;
  /** Shows a proposed change in the editor area's full diff view. */
  onOpenChange: (request: ApprovalRequest) => void;
  onOpenFile: (path: string) => void;
  /** Puts code at the editor cursor; null when no file is open. */
  onInsertCode: ((code: string) => void) | null;
  onNewChat: () => void;
  /** Sends the user message before this assistant message again. */
  onRetry: (messageId: number) => void;
  onContinue: () => void;
  /** When on, the agent's edits are written without asking first. */
  autoApprove: boolean;
  onToggleAutoApprove: () => void;
  /** Estimated share of the model's context the next request uses. */
  context: {
    used: number;
    window: number;
    ratio: number;
    /** Where the window size comes from: the user, the provider, or a default. */
    source: "set" | "reported" | "assumed";
    /** Share at which older turns are condensed. */
    threshold: number;
  };
  /** The summary standing in for older turns, if any. */
  condensed: CondensedHistory | null;
  condensing: boolean;
  canCondense: boolean;
  onCondense: () => void;
  /** Messages waiting for the current reply to finish, in order. */
  queue: { id: number; text: string }[];
  /** A Stop or an error paused the queue. */
  queuePaused: boolean;
  onRemoveQueued: (id: number) => void;
  onResumeQueue: () => void;
  /** Saved sessions of this project, most recent first. */
  sessions: SessionSummary[];
  /** The session shown; null for a new one not yet started. */
  activeSessionId: string | null;
  /** Sessions with a run in progress. */
  runningSessionIds: string[];
  showArchived: boolean;
  onToggleArchived: () => void;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
};

const iconButton =
  "flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:pointer-events-none disabled:opacity-40";

export default function AiAssistant({
  messages,
  configured,
  model,
  pending,
  live,
  contextPath,
  models,
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
  approvals,
  onDecide,
  onOpenChange,
  onOpenFile,
  onInsertCode,
  onNewChat,
  onRetry,
  onContinue,
  autoApprove,
  onToggleAutoApprove,
  context,
  condensed,
  condensing,
  canCondense,
  onCondense,
  queue,
  queuePaused,
  onRemoveQueued,
  onResumeQueue,
  sessions,
  activeSessionId,
  runningSessionIds,
  showArchived,
  onToggleArchived,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  onRenameSession,
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

  // The composer grows with its draft, up to a third of the panel.
  useEffect(() => {
    const node = promptRef.current;

    if (!node) {
      return;
    }

    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [prompt]);

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
  }, [messages, pending, live, approvals]);

  // While the assistant works, sending queues the message instead.
  const canSend = configured && prompt.trim().length > 0;
  const queueing = pending || condensing;

  const submit = () => {
    if (!canSend) {
      return;
    }

    followRef.current = true;
    onSend(prompt.trim());
    setPrompt("");
  };

  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  const timelineProps = {
    approvals,
    onDecide,
    onOpenChange,
    onOpenFile,
    onInsertCode,
    large: full,
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
        <SessionMenu
          sessions={sessions}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          showArchived={showArchived}
          onToggleArchived={onToggleArchived}
          onSelect={onSelectSession}
          onArchive={onArchiveSession}
          onDelete={onDeleteSession}
          onRename={onRenameSession}
          full={full}
        />
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onNewChat}
            disabled={activeSessionId === null && messages.length === 0}
            aria-label="New session"
            title="New session (the current one keeps running)"
            className={iconButton}
          >
            <SquarePen className="size-3.5" strokeWidth={1.75} />
          </button>

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
            className={iconButton}
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
            className={iconButton}
          >
            <Settings2 className="size-3.5" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={onHide}
            aria-label="Hide AI assistant"
            title="Hide AI assistant"
            className={iconButton}
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
                {models.length === 0 ? (
                  <div>
                    <p className="text-[12.5px] text-ink/55">
                      No AI provider connected
                    </p>
                    <p className="mx-auto mt-1 max-w-[30ch] text-[11px] leading-relaxed text-ink/30">
                      Connect a provider to let the assistant read and edit
                      this workspace — a free tier like Groq or Gemini, a
                      router like OpenRouter, or a local model with Ollama.
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-[12.5px] text-ink/55">
                      No model selected
                    </p>
                    <p className="mx-auto mt-1 max-w-[30ch] text-[11px] leading-relaxed text-ink/30">
                      Choose which of your connected models the assistant
                      should use.
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
                >
                  {models.length === 0 ? "Connect a provider" : "Choose a model"}
                </button>
              </div>
            ) : messages.length === 0 && !pending ? (
              <EmptyState full={full} onPick={setPrompt} />
            ) : (
              <ul className="space-y-6">
                {messages.map((message) => (
                  <li key={message.id} className="text-[13px] leading-relaxed">
                    {message.role === "user" ? (
                      <div
                        className={`flex justify-end ${
                          condensed && message.id <= condensed.throughId
                            ? "opacity-60"
                            : ""
                        }`}
                      >
                        <div
                          className={`max-w-[92%] rounded-xl rounded-br-sm border border-ink/[0.07] bg-ink/[0.05] leading-relaxed whitespace-pre-wrap text-ink/85 ${
                            full
                              ? "px-3.5 py-2.5 text-[13px]"
                              : "px-3 py-2 text-[12.5px]"
                          }`}
                        >
                          {message.text}
                        </div>
                      </div>
                    ) : (
                      <div
                        className={
                          condensed && message.id <= condensed.throughId
                            ? "opacity-60"
                            : undefined
                        }
                      >
                        <p className="mb-2 flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25">
                          <Sparkles className="size-3" strokeWidth={1.75} />
                          Assistant
                        </p>
                        {message.error ? (
                          <p className="whitespace-pre-wrap rounded-lg border border-ink/[0.08] bg-ink/[0.03] px-3 py-2 text-[12px] leading-relaxed text-ink/55">
                            {message.text}
                          </p>
                        ) : message.blocks ? (
                          <Timeline blocks={message.blocks} {...timelineProps} />
                        ) : (
                          <MarkdownMessage
                            text={message.text}
                            large={full}
                            codeActions
                            onInsertCode={onInsertCode ?? undefined}
                          />
                        )}

                        {message === lastAssistant && !pending && (
                          <MessageActions
                            message={message}
                            onRetry={() => onRetry(message.id)}
                            onContinue={onContinue}
                          />
                        )}
                      </div>
                    )}
                    {condensed && message.id === condensed.throughId && (
                      <CondensedDivider condensed={condensed} />
                    )}
                  </li>
                ))}
                {pending && (
                  <li className="text-[13px] leading-relaxed">
                    <p className="mb-2 flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/30">
                      <Sparkles className="size-3" strokeWidth={1.75} />
                      Assistant
                    </p>
                    <LiveRun
                      live={live}
                      model={model?.model ?? ""}
                      {...timelineProps}
                    />
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
              title={`The assistant can see ${contextPath}`}
              className="mb-2 flex items-center gap-1.5 rounded-md border border-ink/[0.07] bg-ink/[0.02] px-2 py-1 text-[10px] text-ink/35"
            >
              <File className="size-3 shrink-0 text-ink/25" strokeWidth={1.75} />
              <span className="truncate font-mono">{contextPath}</span>
            </div>
          )}
          {queue.length > 0 && (
            <div className="mb-2 rounded-xl border border-ink/[0.08] bg-ink/[0.02] px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink/40">
                  <ListPlus className="size-3" strokeWidth={1.75} />
                  Queued · {queue.length}
                </span>
                {queuePaused ? (
                  <button
                    type="button"
                    onClick={onResumeQueue}
                    title="Send the queued messages, one after another"
                    className="flex h-6 items-center gap-1 rounded-md bg-ink px-2 text-[10.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
                  >
                    <Play className="size-3" strokeWidth={2} />
                    {pending ? "Resume after this reply" : "Resume"}
                  </button>
                ) : (
                  <span className="text-[10px] text-ink/30">
                    {pending ? "Sent one by one after this reply" : "Sending…"}
                  </span>
                )}
              </div>
              {queuePaused && (
                <p className="mt-1 text-[10.5px] leading-relaxed text-ink/40">
                  Paused after the last reply stopped or failed.
                </p>
              )}
              <ol className="mt-1.5 space-y-1">
                {queue.map((item, index) => (
                  <li
                    key={item.id}
                    className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-ink/[0.04]"
                  >
                    <span className="mt-px w-4 shrink-0 text-right font-mono text-[10px] text-ink/25">
                      {index + 1}
                    </span>
                    <span
                      title={item.text}
                      className="min-w-0 flex-1 truncate text-[11.5px] text-ink/70"
                    >
                      {item.text}
                    </span>
                    <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          setPrompt((current) =>
                            current.trim() ? `${current}\n\n${item.text}` : item.text,
                          );
                          onRemoveQueued(item.id);
                          promptRef.current?.focus();
                        }}
                        aria-label={`Edit queued message ${index + 1}`}
                        title="Edit (moves it back into the message box)"
                        className={iconButton}
                      >
                        <Pencil className="size-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveQueued(item.id)}
                        aria-label={`Remove queued message ${index + 1}`}
                        title="Remove from the queue"
                        className={iconButton}
                      >
                        <X className="size-3" strokeWidth={2} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="rounded-xl border border-ink/[0.08] bg-ink/[0.03] transition-colors duration-150 focus-within:border-ink/20 focus-within:bg-ink/[0.045]">
            {configured && (
              <div
                ref={switcherRef}
                className="relative flex items-center justify-between gap-2 border-b border-ink/[0.05] px-2 py-2"
              >
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={switcherOpen}
                  aria-label={`Model: ${model?.model ?? "none"}. Change model`}
                  title={switcherOpen ? "Close model list" : "Change model"}
                  className={`flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 transition-colors duration-150 ${
                    switcherOpen
                      ? "border-ink/20 bg-ink/[0.07] text-ink/80"
                      : "border-ink/[0.07] bg-ink/[0.02] text-ink/45 hover:border-ink/15 hover:text-ink/70"
                  }`}
                >
                  <Cpu className="size-3 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 max-w-[9rem] truncate font-mono text-[10px]">
                    {model?.model ?? "Choose a model"}
                  </span>
                  <ChevronDown
                    className={`size-3 shrink-0 transition-transform duration-150 ${
                      switcherOpen ? "rotate-180" : ""
                    }`}
                    strokeWidth={2}
                  />
                </button>

                <button
                  type="button"
                  onClick={onToggleAutoApprove}
                  aria-pressed={autoApprove}
                  title={
                    autoApprove
                      ? "Edits are saved without asking. Click to review each edit first."
                      : "Each edit is shown as a diff to accept or reject. Click to save edits without asking."
                  }
                  className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] transition-colors duration-150 ${
                    autoApprove
                      ? "border-ink/20 bg-ink/[0.07] text-ink/75"
                      : "border-ink/[0.07] bg-ink/[0.02] text-ink/45 hover:border-ink/15 hover:text-ink/70"
                  }`}
                >
                  {autoApprove ? (
                    <Zap className="size-3" strokeWidth={1.75} />
                  ) : (
                    <ShieldCheck className="size-3" strokeWidth={1.75} />
                  )}
                  {autoApprove ? "Auto-apply edits" : "Review edits"}
                </button>

                {switcherOpen && (
                  <div
                    role="listbox"
                    aria-label="Model"
                    className="absolute bottom-full left-2 z-30 mb-2 max-h-64 w-[286px] max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-ink/[0.09] bg-raised/95 p-1 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
                  >
                    {models.length === 0 ? (
                      <p className="px-2.5 py-2 text-[11px] leading-relaxed text-ink/35">
                        No models turned on yet. Connect a provider in
                        Settings → AI providers.
                      </p>
                    ) : (
                      models.map((option, index) => {
                        const selected = sameModel(option, model);
                        const ms = option.latency;
                        const heading =
                          index === 0 ||
                          models[index - 1].provider !== option.provider;

                        return (
                          <div key={`${option.provider}/${option.model}`}>
                          {heading && (
                            <p className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-[0.18em] text-ink/30">
                              {option.providerName}
                            </p>
                          )}
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              onSelectModel({
                                provider: option.provider,
                                model: option.model,
                              });
                              setSwitcherOpen(false);
                            }}
                            className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors duration-100 ${
                              selected
                                ? "bg-ink/[0.07] text-ink"
                                : "text-ink/60 hover:bg-ink/[0.05] hover:text-ink/90"
                            }`}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                              {option.model}
                            </span>
                            {ms !== undefined && (
                              <span className="shrink-0 font-mono text-[9.5px] text-ink/25">
                                {ms < 1000
                                  ? `${ms}ms`
                                  : `${(ms / 1000).toFixed(1)}s`}
                              </span>
                            )}
                            {selected && (
                              <Check
                                className="size-3 shrink-0 text-ink"
                                strokeWidth={2.5}
                              />
                            )}
                          </button>
                          </div>
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
              disabled={!configured}
              placeholder={
                !configured
                  ? "Connect a model in Settings"
                  : queueing
                    ? "Add a message; it is sent when this reply finishes…"
                    : "Ask, or describe a change…"
              }
              aria-label="Message the assistant"
              className="block max-h-[220px] w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink placeholder:text-ink/25 focus:outline-none disabled:cursor-not-allowed disabled:text-ink/30"
            />
            <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-2">
              {configured ? (
                <ContextMeter
                  context={context}
                  draftTokens={estimateTokens(prompt)}
                  condensed={condensed}
                  condensing={condensing}
                  canCondense={canCondense}
                  onCondense={onCondense}
                />
              ) : (
                <span className="truncate text-[9.5px] text-ink/25">
                  Enter to send · Shift+Enter for newline
                </span>
              )}
              {queueing ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSend}
                    aria-label="Queue message"
                    title="Queue this message: it is sent when the current reply finishes (Enter)"
                    className="flex h-7 items-center gap-1 rounded-lg bg-ink px-2 text-[10.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/10 disabled:text-ink/30"
                  >
                    <ListPlus className="size-3.5" strokeWidth={2} />
                    Queue
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    aria-label="Stop the assistant"
                    title="Stop the assistant (the queue pauses)"
                    className="flex size-7 items-center justify-center rounded-lg border border-ink/15 text-ink/60 transition-colors duration-150 hover:border-ink/40 hover:bg-ink/[0.06] hover:text-ink"
                  >
                    <Square className="size-3 fill-current" />
                  </button>
                </span>
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

const STARTERS = [
  "Explain how this project is structured",
  "Find likely bugs in the open file",
  "Add comments to the open file",
];

function EmptyState({
  full,
  onPick,
}: {
  full: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-3 text-center ${full ? "mt-32" : "mt-12"}`}
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-ink/[0.03] ring-1 ring-ink/[0.08] ring-inset">
        <Sparkles className="size-4 text-ink/25" strokeWidth={1.5} />
      </span>
      <p className="text-[12px] leading-relaxed text-ink/40">
        Ask about this workspace, or describe a change.
        <br />
        <span className="text-ink/25">
          Edits are shown as a diff before anything is saved.
        </span>
      </p>
      <div className="mt-1 flex w-full max-w-[280px] flex-col gap-1.5">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            type="button"
            onClick={() => onPick(starter)}
            className="rounded-lg border border-ink/[0.07] bg-ink/[0.02] px-2.5 py-1.5 text-left text-[11px] text-ink/45 transition-colors duration-150 hover:border-ink/15 hover:text-ink/75"
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageActions({
  message,
  onRetry,
  onContinue,
}: {
  message: AssistantMessage;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const action =
    "flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-ink/35 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/75";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-0.5">
      {message.outOfSteps && (
        <button
          type="button"
          onClick={onContinue}
          title="Let the assistant keep working where it stopped"
          className="mr-1 flex h-6 items-center gap-1 rounded-md border border-ink/15 bg-ink/[0.05] px-2 text-[10.5px] text-ink/70 transition-colors duration-150 hover:border-ink/30 hover:text-ink"
        >
          <Play className="size-3" strokeWidth={2} />
          Continue
        </button>
      )}
      <button type="button" onClick={onRetry} className={action} title="Ask again">
        <RotateCcw className="size-3" strokeWidth={1.75} />
        Retry
      </button>
      {!message.error && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(message.text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
          className={action}
          title="Copy the answer as Markdown"
        >
          {copied ? (
            <Check className="size-3" strokeWidth={2} />
          ) : (
            <Copy className="size-3" strokeWidth={1.75} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

type TimelineProps = {
  blocks: MessageBlock[];
  approvals: Record<number, ApprovalRequest>;
  onDecide: (stepId: number, accept: boolean) => void;
  onOpenChange: (request: ApprovalRequest) => void;
  onOpenFile: (path: string) => void;
  onInsertCode: ((code: string) => void) | null;
  large: boolean;
  /** The turn is still streaming; the newest thinking stays expanded. */
  live?: boolean;
};

type Group =
  | { type: "steps"; steps: AgentStep[] }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

/** Consecutive tool steps read better as one list than as separate blocks. */
function groupBlocks(blocks: MessageBlock[]): Group[] {
  const groups: Group[] = [];

  for (const block of blocks) {
    const last = groups[groups.length - 1];

    if (block.type === "step") {
      if (block.step.kind === "objectives") {
        continue;
      }

      if (last?.type === "steps") {
        last.steps.push(block.step);
      } else {
        groups.push({ type: "steps", steps: [block.step] });
      }
    } else if (block.text.trim().length > 0) {
      // Neighbouring text (or thinking) is one stream, even in messages saved
      // before streams were joined: never show it as two blocks.
      if (last && last.type === block.type) {
        last.text += block.text;
      } else {
        groups.push({ type: block.type, text: block.text });
      }
    }
  }

  return groups;
}

function Timeline({
  blocks,
  approvals,
  onDecide,
  onOpenChange,
  onOpenFile,
  onInsertCode,
  large,
  live = false,
}: TimelineProps) {
  // Saved turns may hold interleaved pieces; show each turn joined.
  const groups = useMemo(() => groupBlocks(mergeBlocks(blocks)), [blocks]);
  const objectives = useMemo(() => objectivesOf(blocks), [blocks]);

  return (
    <div className="space-y-2.5">
      {groups.map((group, index) => {
        const newest = index === groups.length - 1;

        if (group.type === "steps") {
          return (
            <ul
              key={`steps-${group.steps[0].id}`}
              className="space-y-1 rounded-lg border border-ink/[0.06] bg-ink/[0.015] p-1.5"
            >
              {group.steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  approval={approvals[step.id]}
                  onDecide={onDecide}
                  onOpenChange={onOpenChange}
                  onOpenFile={onOpenFile}
                />
              ))}
            </ul>
          );
        }

        if (group.type === "reasoning") {
          return (
            <Reasoning
              key={`reasoning-${index}`}
              text={group.text}
              open={live && newest}
            />
          );
        }

        return (
          <MarkdownMessage
            key={`text-${index}`}
            text={group.text}
            caret={live && newest}
            large={large}
            codeActions={!live}
            onInsertCode={onInsertCode ?? undefined}
          />
        );
      })}
      {objectives && <Objectives objectives={objectives} live={live} />}
    </div>
  );
}

/**
 * The agent's checklist for a multi-step task, with progress. It closes the
 * turn, below the text, and shows one objective: the one being worked on (or
 * the next one, or a summary once all are done). Clicking it lists them all.
 * While the run works it stays in view at the bottom of the chat.
 */
function Objectives({
  objectives,
  live,
}: {
  objectives: Objective[];
  live: boolean;
}) {
  const done = objectives.filter((objective) => objective.status === "done").length;
  const total = objectives.length;
  const finished = done === total;
  const [expanded, setExpanded] = useState(false);
  const current =
    objectives.find((objective) => objective.status === "in_progress") ??
    objectives.find((objective) => objective.status === "pending");

  return (
    <section
      aria-label="Objectives"
      className={`rounded-lg border border-ink/[0.08] bg-app ${
        live ? "sticky bottom-0 z-10 shadow-[0_-10px_24px_-14px_rgba(0,0,0,0.9)]" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? "Show only the current objective" : "Show all objectives"}
        className="flex w-full items-center gap-2 rounded-lg px-3 pb-2 pt-2.5 text-left transition-colors duration-150 hover:bg-ink/[0.025]"
      >
        {expanded ? (
          <>
            <ListChecks className="size-3.5 shrink-0 text-ink/55" strokeWidth={1.9} />
            <span className="text-[11px] font-medium text-ink/75">Objectives</span>
          </>
        ) : current ? (
          <>
            <ObjectiveIcon status={current.status} live={live} />
            <span
              className={`min-w-0 truncate text-[11px] ${
                current.status === "in_progress"
                  ? "font-medium text-ink/85"
                  : "text-ink/55"
              }`}
            >
              {current.title}
            </span>
          </>
        ) : (
          <>
            <ObjectiveIcon status="done" live={live} />
            <span className="min-w-0 truncate text-[11px] text-ink/55">
              {total === 1 ? "Objective done" : `All ${total} objectives done`}
            </span>
          </>
        )}
        <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] tabular-nums text-ink/40">
          {done}/{total}
        </span>
        <ChevronDown
          className={`size-3 shrink-0 text-ink/30 transition-transform duration-150 ${
            expanded ? "" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
      </button>

      <div
        role="progressbar"
        aria-label="Objectives completed"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="mx-3 mb-2.5 h-[3px] overflow-hidden rounded-full bg-ink/[0.07]"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            finished ? "bg-ink/70" : "bg-ink/45"
          }`}
          style={{ width: `${(done / Math.max(1, total)) * 100}%` }}
        />
      </div>

      {expanded && (
        <ol className="space-y-1.5 px-3 pb-2.5">
          {objectives.map((objective, index) => (
            <li key={`${index}-${objective.title}`} className="flex items-start gap-2">
              <ObjectiveIcon status={objective.status} live={live} />
              <span
                className={`min-w-0 text-[11px] leading-snug ${
                  objective.status === "done"
                    ? "text-ink/35 line-through decoration-ink/20"
                    : objective.status === "in_progress"
                      ? "font-medium text-ink/85"
                      : "text-ink/55"
                }`}
              >
                {objective.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ObjectiveIcon({
  status,
  live,
}: {
  status: Objective["status"];
  live: boolean;
}) {
  const base = "mt-px size-3.5 shrink-0";

  if (status === "done") {
    return <CircleCheck className={`${base} text-ink/45`} strokeWidth={2} aria-label="Done" />;
  }

  if (status === "in_progress") {
    return live ? (
      <LoaderCircle className={`${base} animate-spin text-ink/70`} strokeWidth={2} aria-label="In progress" />
    ) : (
      <CircleDot className={`${base} text-ink/70`} strokeWidth={2} aria-label="In progress" />
    );
  }

  return <Circle className={`${base} text-ink/25`} strokeWidth={2} aria-label="Pending" />;
}

function Reasoning({ text, open }: { text: string; open: boolean }) {
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    setExpanded(open);
  }, [open]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.2em] text-ink/25 transition-colors duration-150 hover:text-ink/55"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
        <Brain className="size-3" strokeWidth={1.75} />
        Thinking
      </button>
      {expanded && (
        <p className="mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap border-l border-ink/[0.07] pl-2.5 text-[11px] leading-relaxed text-ink/35">
          {text}
        </p>
      )}
    </div>
  );
}

function toolIcon(step: AgentStep) {
  switch (step.tool) {
    case "list_files":
      return FolderTree;
    case "read_file":
      return FileText;
    case "search_text":
      return Search;
    case "edit_file":
      return FilePen;
    case "write_file":
      return FilePlus;
    case "run_command":
      return SquareTerminal;
    case "session_status":
      return Users;
    case "message_sessions":
      return Send;
    default:
      return step.kind === "notice" ? Info : Wrench;
  }
}

function StatusIcon({ step }: { step: AgentStep }) {
  if (step.status === "running") {
    return <LoaderCircle className="size-3 animate-spin text-ink/45" />;
  }

  if (step.status === "awaiting") {
    return <Clock className="size-3 text-ink/70" strokeWidth={2} />;
  }

  if (step.kind === "rejected") {
    return <Ban className="size-3 text-ink/35" strokeWidth={2} />;
  }

  if (step.status === "error") {
    return <X className="size-3 text-ink/35" strokeWidth={2.25} />;
  }

  return <Check className="size-3 text-ink/40" strokeWidth={2.25} />;
}

/** The step title with its file path turned into a link to that file. */
function StepTitle({
  step,
  onOpenFile,
}: {
  step: AgentStep;
  onOpenFile: (path: string) => void;
}): ReactNode {
  const path = step.path;
  const at = path ? step.title.lastIndexOf(path) : -1;

  if (!path || at < 0) {
    return step.title;
  }

  return (
    <>
      {step.title.slice(0, at)}
      <button
        type="button"
        onClick={() => onOpenFile(path)}
        title={`Open ${path}`}
        className="font-mono text-[10.5px] text-ink/70 underline decoration-ink/20 underline-offset-2 transition-colors duration-150 hover:text-ink hover:decoration-ink/60"
      >
        {path}
      </button>
      {step.title.slice(at + path.length)}
    </>
  );
}

function StepRow({
  step,
  approval,
  onDecide,
  onOpenChange,
  onOpenFile,
}: {
  step: AgentStep;
  approval: ApprovalRequest | undefined;
  onDecide: (stepId: number, accept: boolean) => void;
  onOpenChange: (request: ApprovalRequest) => void;
  onOpenFile: (path: string) => void;
}) {
  const Icon = toolIcon(step);
  const active = step.status === "running" || step.status === "awaiting";

  return (
    <li className="rounded-md px-1.5 py-1 text-[11px] leading-relaxed">
      <div className="flex items-start gap-2">
        <Icon
          className={`mt-0.5 size-3 shrink-0 ${active ? "text-ink/60" : "text-ink/30"}`}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1">
          <span className={active ? "text-ink/75" : "text-ink/50"}>
            <StepTitle step={step} onOpenFile={onOpenFile} />
          </span>
          {step.detail && (
            <span
              title={step.detail}
              className={`block truncate font-mono text-[10px] ${
                step.status === "error" ? "text-ink/40" : "text-ink/25"
              }`}
            >
              {step.detail}
            </span>
          )}
        </span>
        <span className="mt-0.5 shrink-0">
          <StatusIcon step={step} />
        </span>
      </div>

      {step.status === "awaiting" && approval && approval.kind === "command" && (
        <CommandApproval
          command={approval.command ?? ""}
          onDecide={(accept) => onDecide(step.id, accept)}
        />
      )}
      {step.status === "awaiting" && approval && approval.kind !== "command" && (
        <ApprovalCard
          request={approval}
          onDecide={(accept) => onDecide(step.id, accept)}
          onOpen={() => onOpenChange(approval)}
        />
      )}
    </li>
  );
}

/** A command the agent wants to run, for the user to allow or refuse. */
function CommandApproval({
  command,
  onDecide,
}: {
  command: string;
  onDecide: (accept: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const decide = (accept: boolean) => {
    setBusy(true);
    onDecide(accept);
  };

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-ink/15 bg-app">
      <div className="flex items-center gap-2 border-b border-ink/[0.08] px-2.5 py-1.5 text-[10.5px] text-ink/55">
        <SquareTerminal className="size-3 shrink-0" strokeWidth={1.75} />
        Run this command in the project folder?
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink/85">
        <span className="select-none text-ink/30">$ </span>
        {command}
      </pre>
      <div className="flex items-center justify-end gap-1.5 border-t border-ink/[0.08] px-2 py-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="flex h-6 items-center gap-1 rounded-md border border-ink/[0.1] px-2 text-[10.5px] text-ink/55 transition-colors duration-150 hover:border-ink/25 hover:text-ink disabled:opacity-40"
        >
          <X className="size-3" strokeWidth={2} />
          Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="flex h-6 items-center gap-1 rounded-md bg-ink px-2 text-[10.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:opacity-40"
        >
          <Check className="size-3" strokeWidth={2.5} />
          Run
        </button>
      </div>
    </div>
  );
}

function relativeTime(millis: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - millis) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)} d ago`;
  return new Date(millis).toLocaleDateString();
}

/**
 * The header's session switcher: the current session's name, and a menu of
 * the project's sessions to switch to, rename, archive or delete. Running
 * sessions spin; they keep working while another one is shown.
 */
function SessionMenu({
  sessions,
  activeSessionId,
  runningSessionIds,
  showArchived,
  onToggleArchived,
  onSelect,
  onArchive,
  onDelete,
  onRename,
  full,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  runningSessionIds: string[];
  showArchived: boolean;
  onToggleArchived: () => void;
  onSelect: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  full: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const running = new Set(runningSessionIds);
  const current = sessions.find((session) => session.id === activeSessionId);
  const othersRunning = runningSessionIds.filter((id) => id !== activeSessionId).length;
  const live = sessions.filter((session) => !session.archived);
  const archived = sessions.filter((session) => session.archived);

  useEffect(() => {
    if (!open) {
      setConfirmDelete(null);
      setRenaming(null);
      return;
    }

    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const row = (session: SessionSummary) => {
    const isActive = session.id === activeSessionId;
    const isRunning = running.has(session.id);

    if (confirmDelete === session.id) {
      return (
        <li key={session.id} className="rounded-md bg-ink/[0.05] px-2.5 py-2">
          <p className="text-[11px] text-ink/80">
            Delete “{session.title}”? This can’t be undone.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="h-6 rounded-md border border-ink/[0.1] px-2 text-[10.5px] text-ink/55 hover:border-ink/25 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(null);
                onDelete(session.id);
              }}
              className="h-6 rounded-md bg-ink px-2 text-[10.5px] font-medium text-app hover:bg-ink/90"
            >
              Delete
            </button>
          </div>
        </li>
      );
    }

    if (renaming?.id === session.id) {
      return (
        <li key={session.id} className="px-1.5 py-1">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const title = renaming.title.trim();
              if (title) {
                onRename(session.id, title);
              }
              setRenaming(null);
            }}
          >
            <input
              autoFocus
              value={renaming.title}
              onChange={(event) => setRenaming({ id: session.id, title: event.target.value })}
              onBlur={() => setRenaming(null)}
              aria-label="Session name"
              className="h-7 w-full rounded-md border border-ink/20 bg-app px-2 text-[11px] text-ink outline-none focus:border-ink/40"
            />
          </form>
        </li>
      );
    }

    return (
      <li key={session.id} className="group relative">
        <button
          type="button"
          onClick={() => {
            onSelect(session.id);
            setOpen(false);
          }}
          className={`flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-[4.5rem] text-left transition-colors duration-150 ${
            isActive ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"
          }`}
        >
          {isRunning ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-ink/60" aria-label="Working" />
          ) : (
            <span className={`ml-1 mr-0.5 size-1.5 shrink-0 rounded-full ${isActive ? "bg-ink/60" : "bg-ink/15"}`} />
          )}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[11.5px] ${isActive ? "text-ink/90" : "text-ink/70"}`}>
              {session.title}
            </span>
            <span className="block text-[10px] text-ink/30">
              {isRunning ? "Working…" : relativeTime(session.updatedAt)}
              {session.messageCount > 0 ? ` · ${session.messageCount} messages` : ""}
            </span>
          </span>
        </button>
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setRenaming({ id: session.id, title: session.title })}
            aria-label={`Rename ${session.title}`}
            title="Rename"
            className={iconButton}
          >
            <Pencil className="size-3" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => onArchive(session.id, !session.archived)}
            disabled={isRunning}
            aria-label={session.archived ? `Unarchive ${session.title}` : `Archive ${session.title}`}
            title={isRunning ? "Stop it before archiving" : session.archived ? "Unarchive" : "Archive"}
            className={iconButton}
          >
            {session.archived ? (
              <ArchiveRestore className="size-3" strokeWidth={1.75} />
            ) : (
              <Archive className="size-3" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(session.id)}
            disabled={isRunning}
            aria-label={`Delete ${session.title}`}
            title={isRunning ? "Stop it before deleting" : "Delete"}
            className={iconButton}
          >
            <Trash2 className="size-3" strokeWidth={1.75} />
          </button>
        </span>
      </li>
    );
  };

  return (
    <div ref={menu} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Sessions"
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md py-1 pl-1 pr-1.5 transition-colors duration-150 hover:bg-ink/[0.05]"
      >
        <Sparkles className="size-3.5 shrink-0 text-ink/55" strokeWidth={1.75} />
        <span className={`min-w-0 truncate text-[11px] font-medium text-ink/70 ${full ? "max-w-[420px]" : "max-w-[170px]"}`}>
          {current?.title ?? UNTITLED}
        </span>
        {othersRunning > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-ink/[0.07] px-1.5 py-px text-[9.5px] text-ink/55"
            title={`${othersRunning} other session${othersRunning === 1 ? "" : "s"} working`}
          >
            <LoaderCircle className="size-2.5 animate-spin" />
            {othersRunning}
          </span>
        )}
        <ChevronDown
          className={`size-3 shrink-0 text-ink/35 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1.5 w-[300px] max-w-[calc(100vw-2rem)] rounded-xl border border-ink/[0.09] bg-raised/95 p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
        >
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-ink/40">
              <History className="size-3" strokeWidth={1.75} />
              Sessions
            </span>
            <button
              type="button"
              onClick={onToggleArchived}
              aria-pressed={showArchived}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors duration-150 hover:text-ink ${
                showArchived ? "bg-ink/[0.07] text-ink/70" : "text-ink/40"
              }`}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          </div>

          {live.length === 0 && archived.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-ink/40">
              No saved sessions yet. Your first message starts one.
            </p>
          ) : (
            <ul className="max-h-[340px] space-y-0.5 overflow-y-auto">
              {live.map(row)}
              {showArchived && archived.length > 0 && (
                <>
                  <li className="px-2 pb-1 pt-2.5 text-[9.5px] uppercase tracking-[0.16em] text-ink/30">
                    Archived
                  </li>
                  {archived.map(row)}
                </>
              )}
            </ul>
          )}

          <p className="mt-1 border-t border-ink/[0.07] px-2 pb-1 pt-2 text-[10px] leading-relaxed text-ink/30">
            Sessions can work at the same time. A file one session is editing is
            locked for the others, and each sees what the others changed.
          </p>
        </div>
      )}
    </div>
  );
}

const MAX_PREVIEW_LINES = 400;

function ApprovalCard({
  request,
  onDecide,
  onOpen,
}: {
  request: ApprovalRequest;
  onDecide: (accept: boolean) => void;
  onOpen: () => void;
}) {
  const diff = useMemo(
    () => lineDiff(request.before, request.after),
    [request.before, request.after],
  );
  const [busy, setBusy] = useState(false);
  let shown = 0;

  const decide = (accept: boolean) => {
    setBusy(true);
    onDecide(accept);
  };

  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-ink/15 bg-app">
      <div className="flex items-center gap-2 border-b border-ink/[0.08] px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink/70">
          {request.created ? "New file · " : ""}
          {request.path}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink/50">
          +{diff.added} −{diff.removed}
        </span>
        <button
          type="button"
          onClick={onOpen}
          title="Open in the full diff view"
          aria-label="Open in the full diff view"
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink/35 transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink"
        >
          <Maximize2 className="size-3" strokeWidth={1.75} />
        </button>
      </div>

      <div className="max-h-64 overflow-auto py-1 font-mono text-[10.5px] leading-[1.55]">
        {diff.hunks.map((hunk, hunkIndex) => (
          <div key={`${hunk.oldStart}-${hunk.newStart}`}>
            {hunkIndex > 0 && (
              <div className="my-1 border-t border-dashed border-ink/[0.08]" />
            )}
            {hunk.lines.map((line, index) => {
              shown += 1;

              if (shown > MAX_PREVIEW_LINES) {
                return null;
              }

              return (
                <div
                  key={index}
                  className={`flex min-w-max gap-2 px-2.5 whitespace-pre ${
                    line.kind === "added"
                      ? "bg-ink/[0.07] text-ink/85"
                      : line.kind === "removed"
                        ? "text-ink/35 line-through decoration-ink/20"
                        : "text-ink/40"
                  }`}
                >
                  <span className="w-2 shrink-0 select-none text-ink/30">
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </span>
                  <span>{line.text || " "}</span>
                </div>
              );
            })}
          </div>
        ))}
        {shown > MAX_PREVIEW_LINES && (
          <p className="px-2.5 pt-1 text-ink/30">
            {shown - MAX_PREVIEW_LINES} more lines — open the full diff to see
            them.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-ink/[0.08] px-2 py-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="flex h-6 items-center gap-1 rounded-md border border-ink/[0.1] px-2 text-[10.5px] text-ink/55 transition-colors duration-150 hover:border-ink/25 hover:text-ink disabled:opacity-40"
        >
          <X className="size-3" strokeWidth={2} />
          Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="flex h-6 items-center gap-1 rounded-md bg-ink px-2 text-[10.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:opacity-40"
        >
          <Check className="size-3" strokeWidth={2.5} />
          Accept
        </button>
      </div>
    </div>
  );
}

type LiveRunProps = Omit<TimelineProps, "blocks" | "live"> & {
  live: { blocks: MessageBlock[]; activity?: RunActivity | null } | null;
  model: string;
};

function sizeOf(chars: number): string {
  return chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`;
}

/** The status line for a tool call that is still arriving. */
function callStatus(activity: RunActivity): string {
  const path = activity.path ? activity.path : "a file";
  const size = activity.chars ? ` · ${sizeOf(activity.chars)}` : "";

  switch (activity.tool) {
    case "write_file":
      return `Writing ${path}${size}`;
    case "edit_file":
      return `Preparing an edit to ${path}${size}`;
    case "read_file":
      return `Opening ${path}`;
    case "list_files":
      return "Listing files";
    case "search_text":
      return "Searching";
    case "run_command":
      return "Preparing a command";
    case "set_objectives":
      return "Planning objectives";
    default:
      return activity.tool ? `Calling ${activity.tool}` : "Preparing the next step";
  }
}

/** Seconds without new output after which the status line says so. */
const QUIET_AFTER = 15;

function LiveRun({ live, model, ...timeline }: LiveRunProps) {
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
  const blocks = live?.blocks ?? [];
  const activity = live?.activity ?? null;
  const last = blocks[blocks.length - 1];
  const waitingOnUser = blocks.some(
    (block) => block.type === "step" && block.step.status === "awaiting",
  );
  const since = (time: number) => Math.max(0, Math.floor((now - time) / 1000));
  const quiet = activity ? since(activity.at) : 0;

  // Always say what is happening, so a long tool call or a slow model never
  // looks frozen. A running step shows its own spinner.
  let status: string | null = null;
  if (waitingOnUser) {
    status = null;
  } else if (activity?.phase === "calling") {
    status = `${callStatus(activity)}… ${since(activity.since)}s`;
  } else if (activity?.phase === "waiting") {
    status = `${model ? `Waiting for ${model}` : "Waiting for the model"}… ${since(activity.since)}s`;
  } else if (activity?.phase === "composing") {
    status = `Composing the next step… ${since(activity.since)}s`;
  } else if (activity?.phase === "thinking") {
    status = `Thinking… ${since(activity.since)}s`;
  } else if (activity?.phase === "answering") {
    status = quiet >= QUIET_AFTER ? "Writing the reply…" : null;
  } else if (!last) {
    status = `${model ? `Waiting for ${model}` : "Thinking"}… ${seconds}s`;
  } else if (last.type !== "step" || last.step.status !== "running") {
    status = "Working…";
  }
  const idle = status !== null;
  const slowStart =
    (blocks.length === 0 && seconds >= 20) ||
    (activity?.phase === "waiting" && since(activity.since) >= 20);

  return (
    <div className="space-y-2.5">
      {blocks.length > 0 && <Timeline blocks={blocks} live {...timeline} />}

      {waitingOnUser && (
        <p className="text-[10.5px] text-ink/45">
          Waiting for you to accept or reject…
        </p>
      )}

      {idle && (
        <div className="space-y-1" role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[11px] text-ink/40">
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">{status}</span>
            {activity && activity.phase !== "waiting" && quiet >= QUIET_AFTER && (
              <span className="shrink-0 text-ink/25">· no new output for {quiet}s</span>
            )}
          </p>
          {slowStart && (
            <p className="text-[10px] leading-relaxed text-ink/25">
              Large models can take a minute or more before the first token.
            </p>
          )}
          {activity?.phase === "composing" && since(activity.since) >= 15 && (
            <p className="text-[10px] leading-relaxed text-ink/25">
              The model is writing its next tool call; some providers send it only once it is complete, so a whole file can take a minute or two.
            </p>
          )}
          {activity?.phase === "calling" && activity.tool === "write_file" && since(activity.since) >= 20 && (
            <p className="text-[10px] leading-relaxed text-ink/25">
              The model sends the whole file before it is written; big files take a while.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Marks where the summarised part of the conversation ends. */
function CondensedDivider({ condensed }: { condensed: CondensedHistory }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-[9.5px] uppercase tracking-[0.18em] text-ink/35 transition-colors duration-150 hover:text-ink/65"
      >
        <span className="h-px flex-1 bg-ink/[0.1]" />
        <Layers className="size-3" strokeWidth={1.75} />
        Earlier messages condensed
        {condensed.saved > 0 && (
          <span className="normal-case tracking-normal text-ink/30">
            · ~{formatTokens(condensed.saved)} tokens freed
          </span>
        )}
        <ChevronRight
          className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
        <span className="h-px flex-1 bg-ink/[0.1]" />
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-ink/[0.08] bg-ink/[0.02] px-3 py-2">
          <p className="mb-1.5 text-[10px] text-ink/40">
            The assistant sees this summary instead of the messages above it.
          </p>
          <MarkdownMessage text={condensed.summary} />
        </div>
      )}
    </div>
  );
}

/**
 * A small ring showing how full the model's context will be with the next
 * message; click for the numbers and to condense older turns by hand.
 */
function ContextMeter({
  context,
  draftTokens,
  condensed,
  condensing,
  canCondense,
  onCondense,
}: {
  context: AiAssistantProps["context"];
  draftTokens: number;
  condensed: CondensedHistory | null;
  condensing: boolean;
  canCondense: boolean;
  onCondense: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const used = context.used + draftTokens;
  const ratio = used / Math.max(1, context.window);
  const percent = Math.min(100, Math.round(ratio * 100));
  const near = ratio >= context.threshold * 0.9;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Context ${percent}% used. Show details`}
        title={`≈ ${formatTokens(used)} of ${formatTokens(context.window)} tokens`}
        className={`flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[10px] transition-colors duration-150 hover:bg-ink/[0.06] ${
          near ? "text-ink/75" : "text-ink/35 hover:text-ink/65"
        }`}
      >
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(Math.min(1, ratio) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
          />
        </svg>
        {condensing ? (
          <span className="flex items-center gap-1">
            <LoaderCircle className="size-3 animate-spin" />
            Condensing…
          </span>
        ) : (
          <span className="font-mono">{percent}%</span>
        )}
        <span className="hidden truncate text-ink/25 sm:inline">context</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Context usage"
          className="absolute bottom-full left-0 z-30 mb-2 w-[260px] rounded-xl border border-ink/[0.09] bg-raised/95 p-3 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
        >
          <p className="text-[9.5px] uppercase tracking-[0.18em] text-ink/35">
            Context
          </p>
          <p className="mt-1 font-mono text-[12px] text-ink/85">
            ≈ {formatTokens(used)} / {formatTokens(context.window)} tokens · {percent}%
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/[0.08]">
            <div
              className="h-full rounded-full bg-ink/70"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="relative -mt-1 h-1">
            <span
              className="absolute top-0 h-2 w-px -translate-y-0.5 bg-ink/50"
              style={{ left: `${context.threshold * 100}%` }}
              title={`Condenses at ${Math.round(context.threshold * 100)}%`}
            />
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-ink/45">
            Counts the conversation, the open file, the assistant's tools and
            room for its reply. Older messages are condensed into a summary at{" "}
            {Math.round(context.threshold * 100)}%, so the chat never runs out
            of room.
          </p>
          {context.source === "assumed" && (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink/40">
              This model's window size is an assumption; set the real figure in
              Settings → AI providers.
            </p>
          )}
          {condensed && (
            <p className="mt-1.5 text-[10.5px] text-ink/40">
              Already condensed once · ~{formatTokens(condensed.saved)} tokens freed.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCondense();
            }}
            disabled={!canCondense || condensing}
            title={
              canCondense
                ? "Summarise all but the latest exchanges now"
                : "Nothing old enough to condense yet"
            }
            className="mt-3 flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-ink/[0.1] text-[11px] text-ink/65 transition-colors duration-150 hover:border-ink/25 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <Layers className="size-3.5" strokeWidth={1.75} />
            Condense now
          </button>
        </div>
      )}
    </div>
  );
}
