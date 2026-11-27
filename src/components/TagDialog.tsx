import {
  AlertTriangle,
  CloudUpload,
  GitBranch,
  Info,
  LoaderCircle,
  Tag,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { nextVersions } from "../lib/git";
import type { GitTag } from "../lib/git";

type TagDialogProps = {
  tags: GitTag[];
  /** The branch whose latest commit gets the tag. */
  branch: string;
  /** Uncommitted changes exist, so the tag will not include them. */
  hasChanges: boolean;
  /** Creates the tag; resolves to an error message, or null on success. */
  onCreate: (
    name: string,
    message: string,
    push: boolean,
  ) => Promise<string | null>;
  onClose: () => void;
};

const VERSION_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Rules git enforces for ref names, checked before anything runs. */
function nameProblem(name: string, tags: GitTag[]): string | null {
  if (!name) {
    return null;
  }

  if (tags.some((tag) => tag.name === name)) {
    return "A tag with this name already exists.";
  }

  if (/\s/.test(name) || name.startsWith("-")) {
    return "A tag name cannot contain spaces or start with \"-\".";
  }

  if (
    /\.\.|[~^:?*[\\]|@\{|\/\/|\.lock$|^\.|\/\.|\.$|\/$/.test(name) ||
    name === "@"
  ) {
    return "That is not a valid tag name.";
  }

  return null;
}

/** The "New tag" form: a modal so the choice gets the room it deserves. */
export default function TagDialog({
  tags,
  branch,
  hasChanges,
  onCreate,
  onClose,
}: TagDialogProps) {
  const suggestions = useMemo(() => nextVersions(tags), [tags]);
  const latest = useMemo(
    () => tags.find((tag) => VERSION_TAG.test(tag.name)),
    [tags],
  );

  const [name, setName] = useState(suggestions[0]?.name ?? "");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const problem = nameProblem(trimmed, tags);
  const canCreate = trimmed.length > 0 && !problem && !busy;

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // Escape closes, but never in the middle of a push.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const create = async () => {
    if (!canCreate) {
      return;
    }

    setBusy(true);
    setError(null);
    const failure = await onCreate(trimmed, message, push);
    setBusy(false);

    if (failure) {
      setError(failure);
    } else {
      onClose();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void create();
          }
        }}
        className="w-full max-w-[440px] rounded-2xl border border-ink/10 bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] ring-1 ring-ink/10 ring-inset">
            <Tag className="size-4 text-ink/70" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="tag-dialog-title"
              className="text-[13.5px] font-semibold text-ink/90"
            >
              Create tag
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink/45">
              Tags the latest commit on
              <span className="inline-flex items-center gap-1 rounded bg-ink/[0.06] px-1.5 font-mono text-[10.5px] text-ink/65">
                <GitBranch className="size-3" strokeWidth={1.75} />
                {branch || "HEAD"}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink disabled:opacity-40"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        <div className="space-y-4 px-5 pt-5 pb-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35">
              Version
              {latest && (
                <span className="ml-2 normal-case tracking-normal text-ink/30">
                  latest is {latest.name}
                </span>
              )}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {suggestions.map((suggestion) => {
                const active = trimmed === suggestion.name;

                return (
                  <button
                    key={suggestion.name}
                    type="button"
                    onClick={() => setName(suggestion.name)}
                    aria-pressed={active}
                    className={`rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 ${
                      active
                        ? "border-ink/30 bg-ink/[0.08]"
                        : "border-ink/[0.08] bg-ink/[0.02] hover:border-ink/20 hover:bg-ink/[0.04]"
                    }`}
                  >
                    <span className="block text-[9.5px] uppercase tracking-[0.14em] text-ink/35">
                      {suggestion.label}
                    </span>
                    <span
                      className={`mt-0.5 block font-mono text-[12px] ${active ? "text-ink" : "text-ink/65"}`}
                    >
                      {suggestion.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label
              htmlFor="tag-name"
              className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35"
            >
              Tag name
            </label>
            <input
              id="tag-name"
              ref={nameRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="v1.0.0"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(problem)}
              className={`mt-2 w-full rounded-lg border bg-app px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-ink/20 focus:outline-none ${
                problem
                  ? "border-ink/35"
                  : "border-line focus:border-ink/25"
              }`}
            />
            {problem && (
              <p className="mt-1.5 text-[11px] text-ink/65">{problem}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="tag-message"
              className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35"
            >
              Message
              <span className="ml-2 normal-case tracking-normal text-ink/30">
                optional — makes an annotated tag
              </span>
            </label>
            <textarea
              id="tag-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="What is in this release?"
              rows={3}
              className="mt-2 block w-full resize-none rounded-lg border border-line bg-app px-3 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink/20 focus:border-ink/25 focus:outline-none"
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink/[0.08] bg-ink/[0.02] px-3 py-2.5">
            <input
              type="checkbox"
              checked={push}
              onChange={(event) => setPush(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-ink"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[12px] text-ink/80">
                <CloudUpload className="size-3.5" strokeWidth={1.75} />
                Push to origin
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink/40">
                {push && VERSION_TAG.test(trimmed)
                  ? "Pushing a version tag starts the release build, if the repository has one."
                  : "Leave off to keep the tag on this machine; it can be pushed later from the list."}
              </span>
            </span>
          </label>

          {hasChanges && (
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-ink/50">
              <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              You have uncommitted changes. They are not part of this tag —
              commit them first if they belong in it.
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-ink/15 bg-ink/[0.05] px-3 py-2 text-[11px] leading-relaxed text-ink/75"
            >
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0"
                strokeWidth={1.75}
              />
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ink/[0.08] px-5 py-3">
          <span className="text-[10px] text-ink/25">Ctrl+Enter to create</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-7 rounded-md border border-ink/10 bg-ink/[0.02] px-3 text-[11.5px] text-ink/60 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.08] disabled:text-ink/30"
            >
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {busy
                ? push
                  ? "Creating and pushing…"
                  : "Creating…"
                : push
                  ? "Create & push"
                  : "Create tag"}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
