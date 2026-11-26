import { LoaderCircle, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { readFontUrl } from "../lib/media";
import { toError } from "../lib/tauriBridge";

type FontPreviewProps = {
  path: string;
};

const PANGRAM = "The quick brown fox jumps over the lazy dog";
const SAMPLE = "ABCDEFGHIJKLM abcdefghijklm 0123456789 !?&@#%()[]{}";

function formatBytes(base64: string): string {
  const bytes = Math.round((base64.length * 3) / 4);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A web font has no text to edit, so the editor area draws the face itself:
 * the bytes are read in Rust and injected as an @font-face data URL.
 */
export default function FontPreview({ path }: FontPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const family = useMemo(
    () => `nexium-file-font-${Math.abs(hash(path)).toString(36)}`,
    [path],
  );
  const name = path.split("/").pop() ?? path;

  useEffect(() => {
    let active = true;

    setUrl(null);
    setDemo(false);
    setError(null);

    void readFontUrl(path)
      .then((dataUrl) => {
        if (!active) {
          return;
        }

        if (dataUrl === null) {
          setDemo(true);
          setUrl("");
          return;
        }

        setUrl(dataUrl);
      })
      .catch((cause) => {
        if (active) {
          setError(toError(cause, "Could not open that font.").message);
        }
      });

    return () => {
      active = false;
    };
  }, [path]);

  // In the browser demo there is no real face to read: the specimen still
  // renders, in the bundled mono font, with a note saying so.
  const usedFamily = demo ? '"JetBrains Mono", ui-monospace, monospace' : `"${family}", ui-monospace, monospace`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      {url ? (
        <style>{`@font-face { font-family: "${family}"; src: url("${url}") format("woff2"); font-display: swap; }`}</style>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-9">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Type className="size-5 text-ink/25" strokeWidth={1.5} />
            <p className="text-[12px] text-ink/45">{error}</p>
          </div>
        ) : url === null ? (
          <div className="flex items-center justify-center gap-2 py-16 text-ink/30">
            <LoaderCircle className="size-3.5 animate-spin" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Opening font
            </span>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[780px]">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/25">
              {demo ? "demo preview · bundled face" : "font specimen"}
            </p>

            <p
              className="mt-4 text-[26px] leading-[1.4] text-ink/90"
              style={{ fontFamily: usedFamily }}
            >
              {PANGRAM}
            </p>

            <p
              className="mt-5 text-[15px] leading-[1.6] text-ink/60"
              style={{ fontFamily: usedFamily }}
            >
              {SAMPLE}
            </p>

            <div className="mt-8 grid gap-3 border-t border-line pt-6 sm:grid-cols-3">
              {[13, 17, 21].map((size) => (
                <div key={size}>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink/25">
                    {size}px
                  </span>
                  <p
                    className="mt-1 truncate text-ink/75"
                    style={{ fontFamily: usedFamily, fontSize: size }}
                  >
                    {PANGRAM}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {url !== null && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-3 font-mono text-[10px] text-ink/25">
          <Type className="size-3 shrink-0 text-ink/20" strokeWidth={1.75} />
          <span className="truncate text-ink/40">{name}</span>
          <span aria-hidden className="text-ink/15">
            ·
          </span>
          <span>{(path.split(".").pop() ?? "").toUpperCase()}</span>
          {url && (
            <>
              <span aria-hidden className="text-ink/15">
                ·
              </span>
              <span>{formatBytes(url.split(",")[1] ?? "")}</span>
            </>
          )}
          <span className="ml-auto truncate">{path}</span>
        </div>
      )}
    </div>
  );
}

function hash(value: string): number {
  let result = 0;

  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }

  return result;
}
