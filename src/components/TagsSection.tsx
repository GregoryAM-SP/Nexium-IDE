import {
  ChevronRight,
  CloudUpload,
  LoaderCircle,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { nextVersions } from "../lib/git";
import type { GitTag } from "../lib/git";

type TagsSectionProps = {
  tags: GitTag[];
  /** Uncommitted changes exist, so the tag will not include them. */
  hasChanges: boolean;
  onCreate: (name: string, message: string, push: boolean) => Promise<boolean>;
  onPush: (name: string) => Promise<boolean>;
  onDelete: (name: string) => Promise<boolean>;
};

const VERSION_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHOWN = 8;

function when(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);

  if (days < 1) {
    return "today";
  }

  if (days < 30) {
    return `${days}d ago`;
  }

  return date.toLocaleDateString();
}

/** Lists recent tags and creates, pushes or deletes them. */
export default function TagsSection({
  tags,
  hasChanges,
  onCreate,
  onPush,
  onDelete,
}: TagsSectionProps) {
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const suggestions = useMemo(() => nextVersions(tags), [tags]);
  const trimmed = name.trim();
  const duplicate = tags.some((tag) => tag.name === trimmed);
  const badName = /\s/.test(trimmed) || trimmed.startsWith("-");
  const canCreate = trimmed.length > 0 && !duplicate && !badName && !busy;
  const visible = showAll ? tags : tags.slice(0, SHOWN);

  const startCreating = () => {
    setCreating(true);
    setOpen(true);
    setName(suggestions[0]?.name ?? "");
    setMessage("");
  };

  const create = async () => {
    if (!canCreate) {
      return;
    }

    setBusy("create");
    const ok = await onCreate(trimmed, message, push);
    setBusy(null);

    if (ok) {
      setCreating(false);
      setName("");
      setMessage("");
    }
  };

  const run = async (key: string, action: () => Promise<boolean>) => {
    setBusy(key);
    await action();
    setBusy(null);
  };

  return (
    <div className="mt-1 border-t border-line pt-1">
      <div className="flex h-6 items-center gap-1.5 px-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-ink/30 transition-colors duration-150 hover:text-ink/60"
        >
          <ChevronRight
            className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
          Tags
        </button>
        <span className="rounded bg-ink/[0.05] px-[5px] font-mono text-[9px] leading-4 text-ink/35">
          {tags.length}
        </span>
        {!creating && (
          <button
            type="button"
            onClick={startCreating}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80"
          >
            <Plus className="size-3" strokeWidth={2} />
            New tag
          </button>
        )}
      </div>

      {open && creating && (
        <form
          className="mx-2 mt-1 mb-2 space-y-2 rounded-lg border border-ink/[0.09] bg-ink/[0.02] p-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setCreating(false);
            }
          }}
        >
          <div className="flex flex-wrap gap-1">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.name}
                type="button"
                onClick={() => setName(suggestion.name)}
                title={`${suggestion.label}: ${suggestion.name}`}
                className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors duration-150 ${
                  trimmed === suggestion.name
                    ? "border-ink/25 bg-ink/[0.08] text-ink/85"
                    : "border-ink/[0.08] text-ink/45 hover:border-ink/20 hover:text-ink/75"
                }`}
              >
                {suggestion.name}
              </button>
            ))}
          </div>

          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="v1.0.0"
            aria-label="Tag name"
            spellCheck={false}
            className="w-full rounded-md border border-line bg-app px-2 py-1.5 font-mono text-[11.5px] text-ink placeholder:text-ink/20 focus:border-ink/25 focus:outline-none"
          />
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Message (optional — makes an annotated tag)"
            aria-label="Tag message"
            rows={2}
            className="block w-full resize-none rounded-md border border-line bg-app px-2 py-1.5 text-[11px] leading-relaxed text-ink placeholder:text-ink/20 focus:border-ink/25 focus:outline-none"
          />

          <label className="flex items-center gap-1.5 text-[10.5px] text-ink/50">
            <input
              type="checkbox"
              checked={push}
              onChange={(event) => setPush(event.target.checked)}
              className="size-3 accent-ink"
            />
            Push to origin
          </label>

          {(duplicate || badName) && (
            <p className="text-[10.5px] text-ink/60">
              {duplicate
                ? "That tag already exists."
                : "A tag name cannot start with \"-\" or contain spaces."}
            </p>
          )}
          {push && VERSION_TAG.test(trimmed) && (
            <p className="text-[10px] leading-relaxed text-ink/35">
              Pushing a version tag starts the release build, if the repository
              has one.
            </p>
          )}
          {hasChanges && (
            <p className="text-[10px] leading-relaxed text-ink/35">
              Tags the last commit — uncommitted changes are not included.
            </p>
          )}

          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={!canCreate}
              className="flex h-6 items-center gap-1 rounded-md bg-ink px-2 text-[10.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.07] disabled:text-ink/25"
            >
              {busy === "create" && <LoaderCircle className="size-3 animate-spin" />}
              {push ? "Create & push" : "Create tag"}
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="h-6 rounded-md px-2 text-[10.5px] text-ink/45 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {open && (
        <ul className="space-y-px px-1">
          {tags.length === 0 && !creating && (
            <li className="px-2 py-2 text-[10.5px] text-ink/25">
              No tags yet.
            </li>
          )}
          {visible.map((tag) => (
            <li
              key={tag.name}
              className="group flex h-7 items-center gap-2 rounded-md px-2 hover:bg-ink/[0.04]"
              title={`${tag.name} → ${tag.commit}${tag.subject ? ` · ${tag.subject}` : ""}${tag.annotated ? " (annotated)" : ""}`}
            >
              <Tag
                className={`size-3 shrink-0 ${tag.annotated ? "text-ink/50" : "text-ink/30"}`}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink/70">
                {tag.name}
              </span>

              {confirmDelete === tag.name ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDelete(null);
                      void run(`delete-${tag.name}`, () => onDelete(tag.name));
                    }}
                    className="rounded px-1.5 text-[10px] text-ink/80 hover:bg-ink/[0.08]"
                  >
                    Delete locally
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    className="rounded px-1 text-[10px] text-ink/40 hover:bg-ink/[0.06]"
                  >
                    Keep
                  </button>
                </span>
              ) : busy === `push-${tag.name}` || busy === `delete-${tag.name}` ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin text-ink/40" />
              ) : (
                <>
                  <span className="shrink-0 font-mono text-[9.5px] text-ink/25 group-hover:hidden">
                    {when(tag.date)}
                  </span>
                  <span className="hidden shrink-0 items-center group-hover:flex">
                    <button
                      type="button"
                      onClick={() =>
                        void run(`push-${tag.name}`, () => onPush(tag.name))
                      }
                      disabled={busy !== null}
                      aria-label={`Push ${tag.name} to origin`}
                      title="Push to origin"
                      className="flex size-5 items-center justify-center rounded text-ink/40 hover:bg-ink/[0.08] hover:text-ink"
                    >
                      <CloudUpload className="size-3" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(tag.name)}
                      disabled={busy !== null}
                      aria-label={`Delete ${tag.name}`}
                      title="Delete this tag from the local repository"
                      className="flex size-5 items-center justify-center rounded text-ink/40 hover:bg-ink/[0.08] hover:text-ink"
                    >
                      <Trash2 className="size-3" strokeWidth={1.75} />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
          {tags.length > SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="w-full rounded-md px-2 py-1 text-left text-[10px] text-ink/30 hover:bg-ink/[0.04] hover:text-ink/60"
              >
                {showAll ? "Show fewer" : `Show all ${tags.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
