import {
  ChevronRight,
  CloudUpload,
  LoaderCircle,
  Plus,
  Tag,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { GitTag } from "../lib/git";
import TagDialog from "./TagDialog";

type TagsSectionProps = {
  tags: GitTag[];
  /** The branch whose latest commit a new tag points at. */
  branch: string;
  /** Uncommitted changes exist, so the tag will not include them. */
  hasChanges: boolean;
  /** Resolves to an error message, or null when the tag was created. */
  onCreate: (
    name: string,
    message: string,
    push: boolean,
  ) => Promise<string | null>;
  onPush: (name: string) => Promise<boolean>;
  onDelete: (name: string) => Promise<boolean>;
};

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
  branch,
  hasChanges,
  onCreate,
  onPush,
  onDelete,
}: TagsSectionProps) {
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const visible = showAll ? tags : tags.slice(0, SHOWN);

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
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80"
        >
          <Plus className="size-3" strokeWidth={2} />
          New tag
        </button>
      </div>

      {open && (
        <ul className="space-y-px px-1">
          {tags.length === 0 && (
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

      {creating && (
        <TagDialog
          tags={tags}
          branch={branch}
          hasChanges={hasChanges}
          onCreate={onCreate}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
