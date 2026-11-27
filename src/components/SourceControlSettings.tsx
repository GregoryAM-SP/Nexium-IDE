import { Check, CloudUpload, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  NEXIUM_CO_AUTHOR,
  creditsNexium,
  defaultCommitAction,
  setDefaultCommitAction,
  readGitIdentity,
  saveGitIdentity,
  setCreditsNexium,
} from "../lib/git";
import type { CommitAction, GitIdentity } from "../lib/git";
import { toError } from "../lib/tauriBridge";

export default function SourceControlSettings() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credit, setCredit] = useState(creditsNexium);
  const [commitAction, setCommitAction] =
    useState<CommitAction>(defaultCommitAction);

  useEffect(() => {
    let active = true;

    void readGitIdentity()
      .then((next) => {
        if (!active) {
          return;
        }

        setIdentity(next);
        setName(next.name);
        setEmail(next.email);
      })
      .catch((cause) => {
        if (active) {
          setError(toError(cause, "Could not read the git identity.").message);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const next = await saveGitIdentity(name, email);

      setIdentity(next);
      setName(next.name);
      setEmail(next.email);
      setNotice("Saved. New commits will use this identity.");
    } catch (cause) {
      setError(toError(cause, "Could not save the git identity.").message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[720px] px-10 py-10">
        <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-ink/90">
          Source control
        </h1>
        <p className="mt-1.5 max-w-[52ch] text-[12px] leading-relaxed text-ink/40">
          Git refuses to commit without an author, so the app shows what
          commits will be signed with and lets you set it when it is missing.
        </p>

        <section className="mt-8 rounded-2xl border border-line bg-ink/[0.015] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[12.5px] font-semibold text-ink/80">
                Git identity
              </h2>
              <p className="mt-1 max-w-[46ch] text-[10.5px] leading-relaxed text-ink/30">
                Written to your global git config as user.name and user.email,
                which is where every repository on this machine looks for an
                author.
              </p>
            </div>
            <span
              className={`shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.12em] ${
                identity?.configured
                  ? "border-ink/15 text-ink/55"
                  : "border-ink/10 text-ink/30"
              }`}
            >
              {identity?.configured ? "configured" : "not set"}
            </span>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink/35">
                Name
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
                autoComplete="off"
                spellCheck={false}
                className="mt-2 w-full rounded-lg border border-line bg-app px-3 py-2 font-mono text-[12.5px] text-ink transition-colors duration-150 placeholder:text-ink/20 focus:border-ink/25 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink/35">
                Email
              </span>
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="ada@example.com"
                autoComplete="off"
                spellCheck={false}
                className="mt-2 w-full rounded-lg border border-line bg-app px-3 py-2 font-mono text-[12.5px] text-ink transition-colors duration-150 placeholder:text-ink/20 focus:border-ink/25 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !name.trim() || !email.trim()}
              className="flex h-7 items-center gap-2 rounded-lg bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/15 disabled:text-ink/40"
            >
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {busy ? "Saving…" : "Save identity"}
            </button>

            {notice && (
              <span className="text-[11px] text-ink/45">{notice}</span>
            )}
            {error && (
              <span className="text-[11px] text-red-300/70">{error}</span>
            )}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-ink/[0.015] p-6">
          <h2 className="text-[12.5px] font-semibold text-ink/80">
            Default commit action
          </h2>
          <p className="mt-1 max-w-[52ch] text-[10.5px] leading-relaxed text-ink/30">
            What the Commit button and Ctrl+Enter do in the Source Control
            panel. The arrow beside the button still offers both.
          </p>
          <div
            role="radiogroup"
            aria-label="Default commit action"
            className="mt-4 grid gap-2 sm:grid-cols-2"
          >
            {(
              [
                {
                  id: "commit",
                  title: "Commit",
                  icon: Check,
                  body: "Records the commit on this machine only. Push later with Commit & Sync.",
                },
                {
                  id: "sync",
                  title: "Commit & Sync",
                  icon: CloudUpload,
                  body: "Commits, then pushes the branch to origin (setting origin as its upstream if needed). Nothing is pulled.",
                },
              ] as const
            ).map((option) => {
              const selected = commitAction === option.id;
              const Icon = option.icon;

              return (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors duration-150 focus-within:border-ink/40 ${
                    selected
                      ? "border-ink/30 bg-ink/[0.06]"
                      : "border-ink/[0.08] hover:border-ink/20 hover:bg-ink/[0.03]"
                  }`}
                >
                  <input
                    type="radio"
                    name="default-commit-action"
                    value={option.id}
                    checked={selected}
                    onChange={() => {
                      setCommitAction(option.id);
                      setDefaultCommitAction(option.id);
                    }}
                    className="mt-0.5 size-3.5 shrink-0 accent-ink"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink/85">
                      <Icon className="size-3.5" strokeWidth={2} />
                      {option.title}
                    </span>
                    <span className="mt-1 block text-[10.5px] leading-relaxed text-ink/40">
                      {option.body}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-line bg-ink/[0.015] p-6">
          <label className="flex cursor-pointer items-start justify-between gap-4">
            <span>
              <span className="block text-[12.5px] font-semibold text-ink/80">
                Credit Nexium as a co-author
              </span>
              <span className="mt-1 block max-w-[52ch] text-[10.5px] leading-relaxed text-ink/30">
                Commits made from Nexium Studio end with a{" "}
                <code className="font-mono text-ink/45">
                  Co-authored-by: {NEXIUM_CO_AUTHOR}
                </code>{" "}
                line, so GitHub lists Nexium next to you on each commit. You
                stay the author; the address belongs to no account, so only the
                name is shown.
              </span>
            </span>
            <input
              type="checkbox"
              checked={credit}
              onChange={(event) => {
                setCredit(event.target.checked);
                setCreditsNexium(event.target.checked);
              }}
              className="mt-0.5 size-4 shrink-0 accent-ink"
            />
          </label>
        </section>
      </div>
    </div>
  );
}
