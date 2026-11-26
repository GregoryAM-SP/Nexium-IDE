import { ImageOff, Image as ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type SvgPreviewProps = {
  path: string;
  text: string;
};

/**
 * SVGs are rendered through an `data:` URL in an `<img>` rather than inlined,
 * so a file's own scripts, external references and styles cannot touch the
 * editor; it is drawn the way a browser draws any image.
 */
function toDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export default function SvgPreview({ path, text }: SvgPreviewProps) {
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const src = useMemo(() => toDataUrl(text), [text]);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <ImageIcon className="size-3.5 shrink-0 text-ink/30" strokeWidth={1.75} />
        <span className="text-[11px] text-ink/45">Preview</span>
        {size && (
          <span className="font-mono text-[10px] text-ink/25">
            {Math.round(size.width)} × {Math.round(size.height)}
          </span>
        )}
        <span className="ml-auto truncate font-mono text-[10px] text-ink/25">
          {path}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-[linear-gradient(color-mix(in_srgb,var(--color-ink)_2.2%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_srgb,var(--color-ink)_2.2%,transparent)_1px,transparent_1px)] bg-[length:16px_16px] p-6">
        {!text.trim() ? (
          <p className="text-[12px] text-ink/25">This file is empty.</p>
        ) : failed ? (
          <div className="flex max-w-[34ch] flex-col items-center gap-2 text-center">
            <ImageOff className="size-5 text-ink/25" strokeWidth={1.5} />
            <p className="text-[12px] text-ink/45">
              This SVG could not be rendered.
            </p>
            <p className="text-[11px] leading-relaxed text-ink/25">
              The file is open in the editor — check that it is valid SVG
              markup.
            </p>
          </div>
        ) : (
          <img
            src={src}
            alt={path}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain [image-rendering:auto]"
          />
        )}
      </div>
    </div>
  );
}
