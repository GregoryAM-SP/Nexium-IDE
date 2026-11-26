import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { readImageUrl } from "../lib/media";
import { toError } from "../lib/tauriBridge";

type ImagePreviewProps = {
  path: string;
};

function mimeOf(src: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(src);

  return match ? match[1] : "image";
}

/**
 * Raster images have no text to edit, so the editor area shows the image
 * instead of Monaco: the bytes are read in Rust and handed over as a data URL.
 */
export default function ImagePreview({ path }: ImagePreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;

    setSrc(null);
    setError(null);
    setSize(null);

    void readImageUrl(path)
      .then((url) => {
        if (active) {
          setSrc(url);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(toError(cause, "Could not open that image.").message);
        }
      });

    return () => {
      active = false;
    };
  }, [path]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-[linear-gradient(color-mix(in_srgb,var(--color-ink)_2.2%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_srgb,var(--color-ink)_2.2%,transparent)_1px,transparent_1px)] bg-[length:16px_16px] p-8">
        {error ? (
          <div className="flex max-w-[36ch] flex-col items-center gap-2 text-center">
            <ImageOff className="size-5 text-ink/25" strokeWidth={1.5} />
            <p className="text-[12px] text-ink/45">{error}</p>
          </div>
        ) : !src ? (
          <div className="flex items-center gap-2 text-ink/30">
            <LoaderCircle className="size-3.5 animate-spin" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Opening image
            </span>
          </div>
        ) : (
          <img
            src={src}
            alt={path.split("/").pop() ?? path}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setError("This image could not be displayed.")}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      {size && src && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-3 font-mono text-[10px] text-ink/25">
          <span>
            {Math.round(size.width)} × {Math.round(size.height)}
          </span>
          <span aria-hidden className="text-ink/15">
            ·
          </span>
          <span className="truncate">{mimeOf(src)}</span>
          <span className="ml-auto truncate">{path}</span>
        </div>
      )}
    </div>
  );
}
