import {
  ExternalLink,
  CloudUpload,
  Globe,
  LoaderCircle,
  Lock,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  openOnGitHub,
  publishToGitHub,
  readGitHubAccount,
  repoNameProblem,
  suggestRepoName,
} from "../lib/github";
import type { GitHubAccount, PublishResult } from "../lib/github";

type PublishDialogProps = {
  /** The folder is already a Git repository (otherwise one is started). */
  isRepo: boolean;
  /** The folder sits inside this other repository; it gets its own. */
  nestedIn?: string | null;
  branch: string;
  onPublished: (result: PublishResult) => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

/**
 * "Publish to GitHub": creates a public or private repository under the
 * signed-in account or one of its organisations, makes it this folder's
 * origin and pushes the current branch.
 */
export default function PublishDialog({
  isRepo,
  nestedIn,
  branch,
  onPublished,
  onOpenSettings,
  onClose,
}: PublishDialogProps) {
  const [account, setAccount] = useState<GitHubAccount | null | undefined>(undefined);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;

    void Promise.all([readGitHubAccount(), suggestRepoName()])
      .then(([found, suggested]) => {
        if (!active) return;
        setAccount(found);
        setOwner(found?.login ?? "");
        setName(suggested);
      })
      .catch((cause) => {
        if (!active) return;
        setAccount(null);
        setError(cause instanceof Error ? cause.message : "GitHub could not be reached.");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (account) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [account]);

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

  const trimmed = name.trim();
  const problem = trimmed ? repoNameProblem(trimmed) : null;
  const canPublish = Boolean(account) && trimmed.length > 0 && !problem && !busy;

  const publish = async () => {
    if (!canPublish) return;

    setBusy(true);
    setError(null);

    try {
      const published = await publishToGitHub({
        owner,
        name: trimmed,
        description,
        private: isPrivate,
      });
      setResult(published);
      onPublished(published);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The repository could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const visibility = (value: boolean, title: string, body: string, Icon: typeof Lock) => {
    const active = isPrivate === value;
    return (
      <button
        type="button"
        onClick={() => setPrivate(value)}
        aria-pressed={active}
        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ${
          active
            ? "border-ink/30 bg-ink/[0.08]"
            : "border-ink/[0.08] bg-ink/[0.02] hover:border-ink/20 hover:bg-ink/[0.04]"
        }`}
      >
        <Icon className={`mt-0.5 size-3.5 shrink-0 ${active ? "text-ink/80" : "text-ink/40"}`} strokeWidth={1.75} />
        <span>
          <span className={`block text-[12px] font-medium ${active ? "text-ink/90" : "text-ink/65"}`}>{title}</span>
          <span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink/35">{body}</span>
        </span>
      </button>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          void publish();
        }}
        className="w-full max-w-[460px] rounded-2xl border border-ink/10 bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] ring-1 ring-ink/10 ring-inset">
            <CloudUpload className="size-4 text-ink/75" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="publish-dialog-title" className="text-[13.5px] font-semibold text-ink/90">
              Publish to GitHub
            </h2>
            <p className="mt-1 text-[11.5px] text-ink/45">
              {account
                ? <>Signed in as <span className="text-ink/70">@{account.login}</span>{account.source === "cli" ? " (GitHub CLI)" : ""}</>
                : "Creates a repository on GitHub and pushes this folder to it."}
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

        {result ? (
          <div className="space-y-3 px-5 pb-5 pt-4">
            <p className="text-[12px] leading-relaxed text-ink/75">
              Created <span className="font-mono text-ink">{result.repo.fullName}</span> ({result.repo.private ? "private" : "public"}) and set it as <span className="font-mono">origin</span>.
            </p>
            <p className="rounded-lg bg-ink/[0.04] px-3 py-2 text-[11px] leading-relaxed text-ink/60">
              {result.pushed
                ? `Pushed ${result.status.branch} — it now tracks ${result.status.upstream ?? "origin"}.`
                : result.pushError
                  ? `The push failed: ${result.pushError} Push again from the status bar once that is sorted.`
                  : "Nothing was pushed: this folder has no commits yet. Commit your files, then use Publish branch in the status bar."}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => void openOnGitHub(result.repo.htmlUrl)}
                className="flex h-7 items-center gap-1.5 rounded-md border border-ink/[0.12] px-2.5 text-[11px] text-ink/70 transition-colors duration-150 hover:border-ink/30 hover:text-ink"
              >
                <ExternalLink className="size-3" strokeWidth={1.75} />
                Open on GitHub
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-7 rounded-md bg-ink px-3 text-[11px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
              >
                Done
              </button>
            </div>
          </div>
        ) : account === undefined ? (
          <p className="flex items-center gap-2 px-5 pb-6 pt-5 text-[11.5px] text-ink/45">
            <LoaderCircle className="size-3.5 animate-spin" />
            Checking your GitHub sign-in…
          </p>
        ) : account === null ? (
          <div className="space-y-3 px-5 pb-5 pt-4">
            <p className="text-[11.5px] leading-relaxed text-ink/60">
              Sign in to GitHub first: add a token in Settings → Source control, or sign in with the GitHub CLI (
              <code className="font-mono text-ink/70">gh auth login</code>) and open this again.
            </p>
            {error && <p role="alert" className="text-[11px] text-ink/70">{error}</p>}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
                className="flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[11px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
              >
                <Settings2 className="size-3" strokeWidth={1.75} />
                Open Source control settings
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-5 pb-4 pt-5">
              <div className="grid grid-cols-[auto_1fr] items-end gap-2">
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35">Owner</span>
                  <select
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                    className="mt-1.5 block h-8 max-w-[170px] rounded-md border border-ink/[0.12] bg-app px-2 text-[12px] text-ink outline-none focus:border-ink/35"
                  >
                    {account.owners.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {candidate}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35">Repository name</span>
                  <span className="mt-1.5 flex items-center gap-1.5">
                    <span className="text-[13px] text-ink/30">/</span>
                    <input
                      ref={nameRef}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      spellCheck={false}
                      aria-invalid={Boolean(problem)}
                      className="h-8 min-w-0 flex-1 rounded-md border border-ink/[0.12] bg-app px-2 font-mono text-[12px] text-ink outline-none focus:border-ink/35"
                    />
                  </span>
                </label>
              </div>
              {problem && <p className="-mt-2 text-[10.5px] text-ink/60">{problem}</p>}

              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/35">
                  Description <span className="normal-case tracking-normal text-ink/25">optional</span>
                </span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="mt-1.5 h-8 w-full rounded-md border border-ink/[0.12] bg-app px-2 text-[12px] text-ink outline-none focus:border-ink/35"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                {visibility(true, "Private", "Only you and people you invite can see it.", Lock)}
                {visibility(false, "Public", "Anyone on the internet can see it.", Globe)}
              </div>

              <p className="text-[10.5px] leading-relaxed text-ink/35">
                {nestedIn
                  ? <>This folder is inside the repository at <span className="break-all font-mono">{nestedIn}</span>. A separate repository is started in this folder (on <span className="font-mono">main</span>) and published; the outer one is left as it is. Commit your files afterwards, then publish the branch.</>
                  : isRepo
                    ? <>The repository becomes this folder's <span className="font-mono">origin</span>, and <span className="font-mono">{branch || "the current branch"}</span> is pushed to it.</>
                    : <>This folder is not a Git repository yet: one is started (on <span className="font-mono">main</span>). Commit your files afterwards, then publish the branch.</>}
              </p>

              {error && (
                <p role="alert" className="rounded-lg bg-ink/[0.05] px-3 py-2 text-[11px] leading-relaxed text-ink/75">
                  {error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-ink/[0.07] px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="h-7 rounded-md border border-ink/[0.12] px-3 text-[11px] text-ink/60 transition-colors duration-150 hover:border-ink/30 hover:text-ink disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canPublish}
                className="flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[11px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.08] disabled:text-ink/30"
              >
                {busy && <LoaderCircle className="size-3 animate-spin" />}
                {busy ? "Creating…" : isPrivate ? "Create private repository" : "Create public repository"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}
