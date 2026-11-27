import {
  Check,
  CheckCircle2,
  ChevronDown,
  CloudUpload,
  Folder,
  GitBranch,
  LoaderCircle,
  Minus,
  PanelLeftClose,
  Plus,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { GitChange, GitStatus, GitTag } from "../lib/git";
import ExplorerContextMenu from "./ExplorerContextMenu";
import TagsSection from "./TagsSection";

type SourceControlPanelProps = {
  status: GitStatus | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string) => Promise<boolean>;
  onCommitAndSync: (message: string) => Promise<boolean>;
  onGenerateMessage: () => Promise<string>;
  canGenerate: boolean;
  onSelect: (path: string, staged: boolean) => void;
  onHide: () => void;
  tags: GitTag[];
  /** Resolves to an error message, or null when the tag was created. */
  onCreateTag: (
    name: string,
    message: string,
    push: boolean,
  ) => Promise<string | null>;
  onPushTag: (name: string) => Promise<boolean>;
  onDeleteTag: (name: string) => Promise<boolean>;
};

const iconButton =
  "flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:text-ink/15";

const statusTone: Record<string, string> = {
  M: "text-ink/70",
  A: "text-ink/85",
  D: "text-ink/35",
  R: "text-ink/60",
  C: "text-ink/60",
  U: "text-ink/40",
};

const INDENT = 13;

/** A directory of the change tree; only folders that contain changes exist. */
type DirNode = {
  name: string;
  children: Map<string, DirNode>;
  files: GitChange[];
};

function buildTree(changes: GitChange[]): DirNode {
  const root: DirNode = { name: "", children: new Map(), files: [] };

  for (const change of changes) {
    const parts = change.path.split("/");
    let node = root;

    for (const part of parts.slice(0, -1)) {
      let next = node.children.get(part);

      if (!next) {
        next = { name: part, children: new Map(), files: [] };
        node.children.set(part, next);
      }

      node = next;
    }

    node.files.push(change);
  }

  return root;
}

function countFiles(node: DirNode): number {
  let total = node.files.length;

  for (const child of node.children.values()) {
    total += countFiles(child);
  }

  return total;
}

function ChangeRow({
  change,
  depth,
  onSelect,
  onToggle,
}: {
  change: GitChange;
  depth: number;
  onSelect: (path: string, staged: boolean) => void;
  onToggle: (path: string) => void;
}) {
  const name = change.path.split("/").pop() ?? change.path;
  const deleted = change.status === "D";

  return (
    <div className="group flex items-center rounded-md transition-colors duration-150 hover:bg-ink/[0.045]">
      <button
        type="button"
        onClick={() => {
          if (!deleted) {
            onSelect(change.path, change.staged);
          }
        }}
        disabled={deleted}
        title={deleted ? `${change.path} (deleted)` : change.path}
        style={{ paddingLeft: 8 + depth * INDENT }}
        className="flex min-w-0 flex-1 items-center gap-2 py-[5px] text-left disabled:cursor-default"
      >
        <span
          className={`flex size-[15px] shrink-0 items-center justify-center rounded-[4px] bg-ink/[0.05] font-mono text-[9px] leading-none ring-1 ring-ink/[0.06] ring-inset ${
            statusTone[change.status] ?? "text-ink/50"
          }`}
        >
          {change.status}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${
            deleted
              ? "text-ink/35 line-through"
              : "text-ink/70 group-hover:text-ink/90"
          }`}
        >
          {name}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onToggle(change.path)}
        aria-label={change.staged ? `Unstage ${name}` : `Stage ${name}`}
        title={change.staged ? "Unstage" : "Stage"}
        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-ink/25 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-ink/10 hover:text-ink focus-visible:opacity-100"
      >
        {change.staged ? (
          <Minus className="size-3" strokeWidth={2} />
        ) : (
          <Plus className="size-3" strokeWidth={2} />
        )}
      </button>
    </div>
  );
}

function TreeRows({
  node,
  depth,
  onSelect,
  onToggle,
}: {
  node: DirNode;
  depth: number;
  onSelect: (path: string, staged: boolean) => void;
  onToggle: (path: string) => void;
}) {
  const folders = [...node.children.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [...node.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  return (
    <>
      {folders.map((folder) => (
        <div key={`folder-${folder.name}`}>
          <div
            style={{ paddingLeft: 8 + depth * INDENT }}
            className="flex h-[23px] items-center gap-1.5 pr-2"
          >
            <Folder
              className="size-3 shrink-0 text-ink/20"
              strokeWidth={1.75}
            />
            <span className="min-w-0 truncate font-mono text-[10.5px] text-ink/40">
              {folder.name}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[9px] text-ink/20">
              {countFiles(folder)}
            </span>
          </div>
          <TreeRows
            node={folder}
            depth={depth + 1}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        </div>
      ))}

      {files.map((change) => (
        <ChangeRow
          key={`${change.staged ? "staged" : "worktree"}-${change.path}`}
          change={change}
          depth={depth}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function Group({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <div className="pt-1">
      <div className="flex h-6 items-center gap-1.5 px-2">
        <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-ink/30">
          {title}
        </span>
        <span className="rounded bg-ink/[0.05] px-[5px] font-mono text-[9px] leading-4 text-ink/35">
          {count}
        </span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80"
          >
            {action.label}
          </button>
        )}
      </div>
      <div className="space-y-0.5 px-1">{children}</div>
    </div>
  );
}

export default function SourceControlPanel({
  status,
  busy,
  error,
  onRefresh,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  onCommitAndSync,
  onGenerateMessage,
  canGenerate,
  onSelect,
  onHide,
  tags,
  onCreateTag,
  onPushTag,
  onDeleteTag,
}: SourceControlPanelProps) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const commitGroup = useRef<HTMLSpanElement>(null);

  const staged = status?.changes.filter((change) => change.staged) ?? [];
  const unstaged = status?.changes.filter((change) => !change.staged) ?? [];
  const total = staged.length + unstaged.length;
  const canCommit = staged.length > 0 && message.trim().length > 0 && !committing;

  const commit = async (sync = false) => {
    if (!canCommit) {
      return;
    }

    setCommitMenu(null);
    setCommitting(true);

    try {
      const committed = sync
        ? await onCommitAndSync(message)
        : await onCommit(message);

      if (committed) {
        setMessage("");
      }
    } finally {
      setCommitting(false);
    }
  };

  const toggleCommitMenu = () => {
    if (commitMenu) {
      setCommitMenu(null);

      return;
    }

    const rect = commitGroup.current?.getBoundingClientRect();

    if (rect) {
      // Two 32px items plus the menu's padding, opened above the button.
      setCommitMenu({ x: rect.right - 212, y: rect.top - 82 });
    }
  };

  const generate = async () => {
    if (generating || staged.length === 0) {
      return;
    }

    setGenerating(true);
    setGenerateError(null);

    try {
      setMessage(await onGenerateMessage());
    } catch (cause) {
      setGenerateError(
        cause instanceof Error
          ? cause.message
          : "Could not generate a commit message.",
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent px-3">
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/40">
          <GitBranch
            className="size-3.5 shrink-0 text-ink/30"
            strokeWidth={1.75}
          />
          <span className="truncate">Source control</span>
          {total > 0 && (
            <span className="shrink-0 rounded bg-ink/[0.07] px-1.5 font-mono text-[9px] leading-4 tracking-normal text-ink/45">
              {total}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            aria-label="Refresh source control"
            title="Refresh"
            className={iconButton}
          >
            <RotateCw
              className={`size-3.5 ${busy ? "animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </button>
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide source control"
            title="Hide source control"
            className={iconButton}
          >
            <PanelLeftClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      {status && !status.isRepo ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <div className="rounded-xl border border-line bg-ink/[0.015] p-3">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-ink/[0.04] ring-1 ring-ink/[0.07] ring-inset">
                <GitBranch
                  className="size-3.5 text-ink/35"
                  strokeWidth={1.75}
                />
              </span>
              <div className="min-w-0">
                <p className="text-[11.5px] text-ink/65">
                  Not a Git repository
                </p>
                <p className="mt-0.5 text-[10.5px] text-ink/30">
                  This folder has no .git directory yet.
                </p>
              </div>
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-ink/25">
              Run this in the folder, then refresh:
            </p>
            <code className="mt-1.5 block rounded-md border border-ink/[0.07] bg-app px-2 py-1.5 font-mono text-[10.5px] text-ink/50">
              git init
            </code>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <GitBranch
              className="size-3.5 shrink-0 text-ink/30"
              strokeWidth={1.75}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink/55">
              {status?.branch || (busy ? "Reading repository…" : "no branch")}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] text-ink/25">
              {total === 0 ? "clean" : `${total} change${total === 1 ? "" : "s"}`}
            </span>
          </div>

          <div className="shrink-0 border-b border-line p-2">
            <div className="relative rounded-xl border border-line bg-ink/[0.015] transition-colors duration-150 focus-within:border-ink/20">
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!canGenerate || staged.length === 0 || generating}
                aria-label="Generate commit message"
                title={
                  !canGenerate
                    ? "Select a model in Settings to generate a message"
                    : staged.length === 0
                      ? "Stage changes to generate a message"
                      : "Generate commit message"
                }
                className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:text-ink/15 disabled:hover:bg-transparent"
              >
                {generating ? (
                  <LoaderCircle
                    className="size-3.5 animate-spin"
                    strokeWidth={1.75}
                  />
                ) : (
                  <Sparkles className="size-3.5" strokeWidth={1.75} />
                )}
              </button>
              <textarea
                rows={2}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void commit();
                  }
                }}
                placeholder={
                  staged.length > 0
                    ? "Describe the change"
                    : "Stage changes to commit"
                }
                aria-label="Commit message"
                className="w-full resize-none rounded-t-xl bg-transparent pt-2 pr-9 pb-1 pl-2.5 text-[11.5px] leading-relaxed text-ink/80 outline-none placeholder:text-ink/25"
              />
              <div className="flex items-center justify-between gap-2 border-t border-ink/[0.05] py-1.5 pr-1.5 pl-2.5">
                <span
                  title={generateError ?? undefined}
                  className={`truncate text-[9.5px] ${
                    generateError ? "text-red-300/70" : "text-ink/25"
                  }`}
                >
                  {generateError ??
                    (staged.length === 0
                      ? "nothing staged"
                      : `${staged.length} staged`)}
                </span>
                <span
                  ref={commitGroup}
                  className="flex shrink-0 items-center"
                >
                  <button
                    type="button"
                    onClick={() => void commit()}
                    disabled={!canCommit}
                    className="flex h-6 items-center gap-1 rounded-l-md bg-ink px-2.5 text-[11px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.07] disabled:text-ink/25"
                  >
                    <Check className="size-3" strokeWidth={2.4} />
                    Commit
                  </button>
                  <button
                    type="button"
                    onClick={toggleCommitMenu}
                    disabled={!canCommit}
                    aria-label="Commit options"
                    aria-haspopup="menu"
                    aria-expanded={Boolean(commitMenu)}
                    title="Commit options"
                    className="flex h-6 w-5 items-center justify-center rounded-r-md border-l border-app/25 bg-ink text-app transition-colors duration-150 hover:bg-ink/90 disabled:border-app/10 disabled:bg-ink/[0.07] disabled:text-ink/25"
                  >
                    <ChevronDown className="size-3" strokeWidth={2.4} />
                  </button>
                </span>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {staged.length > 0 && (
              <Group
                title="Staged"
                count={staged.length}
                action={{ label: "Unstage all", onClick: onUnstageAll }}
              >
                <TreeRows
                  node={buildTree(staged)}
                  depth={0}
                  onSelect={onSelect}
                  onToggle={onUnstage}
                />
              </Group>
            )}

            {unstaged.length > 0 && (
              <Group
                title="Changes"
                count={unstaged.length}
                action={{ label: "Stage all", onClick: onStageAll }}
              >
                <TreeRows
                  node={buildTree(unstaged)}
                  depth={0}
                  onSelect={onSelect}
                  onToggle={onStage}
                />
              </Group>
            )}

            {total === 0 && (
              <div className="flex flex-col items-center gap-2.5 px-6 py-10 text-center">
                <span className="flex size-9 items-center justify-center rounded-xl bg-ink/[0.03] ring-1 ring-ink/[0.07] ring-inset">
                  <CheckCircle2
                    className="size-4 text-ink/30"
                    strokeWidth={1.5}
                  />
                </span>
                <div>
                  <p className="text-[11.5px] text-ink/50">
                    {busy ? "Reading repository…" : "Working tree clean"}
                  </p>
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink/25">
                    {busy
                      ? "Checking for changes"
                      : "No staged or unstaged changes"}
                  </p>
                </div>
              </div>
            )}

            <TagsSection
              tags={tags}
              branch={status?.branch ?? ""}
              hasChanges={total > 0}
              onCreate={onCreateTag}
              onPush={onPushTag}
              onDelete={onDeleteTag}
            />
          </div>
        </>
      )}

      {commitMenu && (
        <ExplorerContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          label="Commit options"
          boundary={commitGroup}
          onClose={() => setCommitMenu(null)}
          items={[
            {
              label: "Commit",
              icon: Check,
              disabled: !canCommit,
              onSelect: () => void commit(),
            },
            {
              label: "Commit & Sync",
              icon: CloudUpload,
              disabled: !canCommit,
              onSelect: () => void commit(true),
            },
          ]}
        />
      )}

      <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-line px-3">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            error ? "bg-red-400/70" : busy ? "bg-ink/25" : "bg-ink/40"
          }`}
        />
        <span
          title={error ?? undefined}
          className={`truncate font-mono text-[9.5px] ${
            error ? "text-red-300/70" : "text-ink/25"
          }`}
        >
          {error ?? (busy ? "refreshing…" : "git")}
        </span>
      </div>
    </aside>
  );
}
