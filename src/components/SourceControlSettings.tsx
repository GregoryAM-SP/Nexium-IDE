import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { readGitIdentity, saveGitIdentity } from "../lib/git";
import type { GitIdentity } from "../lib/git";
import { toError } from "../lib/tauriBridge";

export default function SourceControlSettings() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      </div>
    </div>
  );
}
