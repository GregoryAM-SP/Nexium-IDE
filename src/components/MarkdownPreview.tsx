import { Eye } from "lucide-react";
import type { Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useRef } from "react";

import MarkdownMessage from "./MarkdownMessage";

export type MarkdownPreviewHandle = {
  /** Scroll so the block containing `line` sits at the top of the pane. */
  scrollToLine: (line: number) => void;
};

type MarkdownPreviewProps = {
  path: string;
  text: string;
  /** Fires while the preview scrolls, with the interpolated source line. */
  onLineChange?: (line: number) => void;
  ref?: Ref<MarkdownPreviewHandle>;
};

/** A rendered block and the source line it starts on. */
type Anchor = { line: number; top: number };

/**
 * Renders the open markdown file the way it will read elsewhere, using the same
 * component map as assistant replies so both stay visually in sync.
 */
export default function MarkdownPreview({
  path,
  text,
  onLineChange,
  ref,
}: MarkdownPreviewProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<Anchor[]>([]);

  /**
   * Rendered blocks are not one-to-one with source lines (a table or code block
   * is many lines tall), so scrolling is mapped between the two through the
   * blocks' source lines: `data-line` marks where each block starts.
   */
  const rebuild = useCallback(() => {
    const pane = paneRef.current;

    if (!pane) {
      return;
    }

    const origin = pane.getBoundingClientRect().top - pane.scrollTop;
    const anchors: Anchor[] = [];

    for (const element of pane.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(element.dataset.line);
      const top = element.getBoundingClientRect().top - origin;

      if (!Number.isFinite(line) || !Number.isFinite(top)) {
        continue;
      }

      const previous = anchors[anchors.length - 1];

      if (previous && top <= previous.top) {
        continue;
      }

      anchors.push({ line, top });
    }

    anchorsRef.current = anchors;
  }, []);

  useEffect(() => {
    rebuild();
  }, [rebuild, text]);

  useEffect(() => {
    const pane = paneRef.current;

    if (!pane) {
      return;
    }

    const observer = new ResizeObserver(() => rebuild());
    observer.observe(pane);

    return () => observer.disconnect();
  }, [rebuild]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line) {
        const pane = paneRef.current;
        const anchors = anchorsRef.current;

        if (!pane || anchors.length === 0) {
          return;
        }

        let top = 0;

        if (line > anchors[0].line) {
          let index = 0;

          while (
            index + 1 < anchors.length &&
            anchors[index + 1].line <= line
          ) {
            index += 1;
          }

          const start = anchors[index];
          const next = anchors[index + 1];

          top = next
            ? start.top +
              ((line - start.line) / Math.max(1, next.line - start.line)) *
                (next.top - start.top)
            : start.top;
        }

        pane.scrollTop = Math.min(
          Math.max(0, top),
          pane.scrollHeight - pane.clientHeight,
        );
      },
    }),
    [],
  );

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <Eye className="size-3.5 shrink-0 text-ink/30" strokeWidth={1.75} />
        <span className="text-[11px] text-ink/45">Preview</span>
        <span className="ml-auto truncate font-mono text-[10px] text-ink/25">
          {path}
        </span>
      </div>

      <div
        ref={paneRef}
        onScroll={(event) => {
          const pane = event.currentTarget;
          const anchors = anchorsRef.current;

          if (!onLineChange) {
            return;
          }

          if (anchors.length === 0) {
            onLineChange(1);
            return;
          }

          const scrollTop = pane.scrollTop;
          let index = 0;

          while (
            index + 1 < anchors.length &&
            anchors[index + 1].top <= scrollTop
          ) {
            index += 1;
          }

          const start = anchors[index];
          const next = anchors[index + 1];
          const line =
            next && next.top > start.top
              ? start.line +
                ((scrollTop - start.top) / (next.top - start.top)) *
                  (next.line - start.line)
              : start.line;

          onLineChange(Math.max(1, Math.round(line)));
        }}
        className="min-h-0 flex-1 overflow-y-auto px-7 py-6"
      >
        {text.trim() ? (
          <div className="mx-auto w-full max-w-[46rem]">
            <MarkdownMessage text={text} large sourceLines />
          </div>
        ) : (
          <p className="text-[12px] text-ink/25">This file is empty.</p>
        )}
      </div>
    </div>
  );
}
