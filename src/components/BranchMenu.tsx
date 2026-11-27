import { Check, Cloud, GitBranch, GitBranchPlus, LoaderCircle, Search, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GitBranch as Branch, GitTag } from "../lib/git";

type BranchMenuProps = {
  current: string;
  /** Loads the list each time the menu opens. */
  load: () => Promise<Branch[]>;
  /** Loads the tags each time the menu opens. */
  loadTags: () => Promise<GitTag[]>;
  /** Resolve to an error message, or null when it worked (the menu closes). */
  onSwitch: (branch: Branch) => Promise<string | null>;
  onCheckoutTag: (tag: GitTag) => Promise<string | null>;
  onCreate: (name: string) => Promise<string | null>;
  onClose: () => void;
};

function ago(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (elapsed < 60) return "just now";
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)} min ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)} h ago`;
  if (elapsed < 30 * 86_400) return `${Math.floor(elapsed / 86_400)} d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

/**
 * The status bar's branch picker: type to filter, pick a branch to switch to
 * it (a remote one becomes a local branch that tracks it), or create a new
 * branch from the current commit with the typed name.
 */
export default function BranchMenu({
  current,
  load,
  loadTags,
  onSwitch,
  onCheckoutTag,
  onCreate,
  onClose,
}: BranchMenuProps) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((list) => !cancelled && setBranches(list))
      .catch((cause) => {
        if (!cancelled) {
          setBranches([]);
          setError(cause instanceof Error ? cause.message : "The branches could not be listed.");
        }
      });
    // A repository without tags is fine; the section just stays away.
    loadTags()
      .then((list) => !cancelled && setTags(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [load, loadTags]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const name = query.trim();
  const filtered = useMemo(() => {
    const needle = name.toLowerCase();
    return (branches ?? []).filter((branch) => branch.name.toLowerCase().includes(needle));
  }, [branches, name]);
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);
  const matchingTags = useMemo(() => {
    const needle = name.toLowerCase();
    return tags.filter((tag) => tag.name.toLowerCase().includes(needle));
  }, [tags, name]);
  // The status reads "v1.0.0 (detached)" while a tag is checked out.
  const currentTag = current.endsWith(" (detached)") ? current.slice(0, -" (detached)".length) : null;
  const exists = (branches ?? []).some((branch) => !branch.remote && branch.name === name);
  const canCreate = name.length > 0 && !exists;

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    const failure = await action();
    setBusy(null);
    if (failure) {
      setError(failure);
    } else {
      onClose();
    }
  };

  const create = () => {
    if (canCreate && !busy) {
      void run(`create:${name}`, () => onCreate(name));
    }
  };

  const tagRow = (tag: GitTag) => {
    const key = `tag:${tag.name}`;
    const isCurrent = tag.name === currentTag;
    const when = Date.parse(tag.date);
    return (
      <li key={key}>
        <button
          type="button"
          disabled={isCurrent || busy !== null}
          onClick={() => void run(key, () => onCheckoutTag(tag))}
          title={`Check out ${tag.name} (${tag.commit}). You will be on that commit, not on a branch: create a branch there to commit.`}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 disabled:cursor-default ${
            isCurrent ? "bg-ink/[0.07]" : "hover:bg-ink/[0.05]"
          }`}
        >
          {busy === key ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-ink/60" />
          ) : isCurrent ? (
            <Check className="size-3 shrink-0 text-ink/70" strokeWidth={2.25} />
          ) : (
            <Tag className="size-3 shrink-0 text-ink/35" strokeWidth={1.75} />
          )}
          <span className="min-w-0 flex-1">
            <span className={`block truncate font-mono text-[11px] ${isCurrent ? "text-ink/90" : "text-ink/70"}`}>
              {tag.name}
            </span>
            <span className="block truncate text-[10px] text-ink/30">
              {Number.isNaN(when) ? "" : ago(Math.floor(when / 1000))}
              {tag.subject ? ` · ${tag.subject}` : ""}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[9.5px] text-ink/25">{tag.commit}</span>
        </button>
      </li>
    );
  };

  const row = (branch: Branch) => {
    const key = `branch:${branch.name}`;
    return (
      <li key={key}>
        <button
          type="button"
          disabled={branch.current || busy !== null}
          onClick={() => void run(key, () => onSwitch(branch))}
          title={branch.remote ? `Check out ${branch.name} as a local branch` : `Switch to ${branch.name}`}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 disabled:cursor-default ${
            branch.current ? "bg-ink/[0.07]" : "hover:bg-ink/[0.05]"
          }`}
        >
          {busy === key ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-ink/60" />
          ) : branch.current ? (
            <Check className="size-3 shrink-0 text-ink/70" strokeWidth={2.25} />
          ) : branch.remote ? (
            <Cloud className="size-3 shrink-0 text-ink/35" strokeWidth={1.75} />
          ) : (
            <GitBranch className="size-3 shrink-0 text-ink/35" strokeWidth={1.75} />
          )}
          <span className="min-w-0 flex-1">
            <span className={`block truncate font-mono text-[11px] ${branch.current ? "text-ink/90" : "text-ink/70"}`}>
              {branch.name}
            </span>
            <span className="block truncate text-[10px] text-ink/30">
              {ago(branch.updated)}
              {branch.subject ? ` · ${branch.subject}` : ""}
            </span>
          </span>
          {branch.upstream && !branch.remote && (
            <span className="shrink-0 font-mono text-[9.5px] text-ink/25">{branch.upstream}</span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Branches"
      className="absolute bottom-full left-0 z-40 mb-1 w-[340px] max-w-[calc(100vw-1rem)] rounded-xl border border-ink/[0.09] bg-raised/95 p-1.5 shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) {
            create();
          } else if (local.length + remote.length === 1) {
            const only = local[0] ?? remote[0];
            if (!only.current) {
              void run(`branch:${only.name}`, () => onSwitch(only));
            }
          }
        }}
        className="flex items-center gap-2 rounded-md border border-ink/[0.1] bg-app px-2 focus-within:border-ink/30"
      >
        <Search className="size-3 shrink-0 text-ink/30" strokeWidth={1.75} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a branch or tag, or name a new branch"
          aria-label="Find or name a branch"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:font-sans placeholder:text-ink/30"
        />
      </form>

      {canCreate && (
        <button
          type="button"
          onClick={create}
          disabled={busy !== null}
          className="mt-1.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-ink/80 transition-colors duration-150 hover:bg-ink/[0.06] disabled:opacity-50"
        >
          {busy === `create:${name}` ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
          ) : (
            <GitBranchPlus className="size-3 shrink-0" strokeWidth={1.75} />
          )}
          <span className="min-w-0 truncate">
            Create branch <span className="font-mono text-ink">{name}</span> from{" "}
            <span className="font-mono">{current}</span> and switch to it
          </span>
        </button>
      )}

      {error && (
        <p role="alert" className="mt-1.5 rounded-md bg-ink/[0.05] px-2 py-1.5 text-[10.5px] leading-relaxed text-ink/70">
          {error}
        </p>
      )}

      <div className="mt-1.5 max-h-[320px] overflow-y-auto">
        {branches === null ? (
          <p className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-ink/40">
            <LoaderCircle className="size-3 animate-spin" />
            Loading branches…
          </p>
        ) : local.length + remote.length + matchingTags.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-ink/40">
            {name ? "No branch or tag matches." : "No branches yet."}
          </p>
        ) : (
          <>
            {local.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-0.5 text-[9.5px] uppercase tracking-[0.16em] text-ink/30">Branches</p>
                <ul className="space-y-0.5">{local.map(row)}</ul>
              </>
            )}
            {remote.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-2 text-[9.5px] uppercase tracking-[0.16em] text-ink/30">Remote only</p>
                <ul className="space-y-0.5">{remote.map(row)}</ul>
              </>
            )}
            {matchingTags.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-2 text-[9.5px] uppercase tracking-[0.16em] text-ink/30">Tags</p>
                <ul className="space-y-0.5">{matchingTags.map(tagRow)}</ul>
              </>
            )}
          </>
        )}
      </div>

      <p className="mt-1 border-t border-ink/[0.07] px-2 pb-0.5 pt-1.5 text-[10px] leading-relaxed text-ink/30">
        Uncommitted changes come along when you switch; Git stops if they would be overwritten. A tag opens its commit on no branch: create a branch there to commit.
      </p>
    </div>
  );
}
