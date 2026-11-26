import { DiffEditor } from "@monaco-editor/react";
import { ChevronRight, X } from "lucide-react";

import { languageForPath } from "../lib/languages";

type DiffViewProps = {
  path: string;
  /** A staged change compares HEAD against the index, the rest against disk. */
  staged: boolean;
  original: string;
  modified: string;
  onClose: () => void;
};

/** A read-only side-by-side diff of one change, in place of the editor. */
export default function DiffView({
  path,
  staged,
  original,
  modified,
  onClose,
}: DiffViewProps) {
  const name = path.split("/").pop() ?? path;
  const segments = path ? path.split("/") : [];
  // Stable, app-owned model paths: the wrapper must not dispose these itself,
  // because it does so before Monaco's diff widget lets go of them. App closes
  // the diff first and disposes the models afterwards.
  const base = `inmemory://nexium-diff/${encodeURIComponent(path)}/${staged ? "staged" : "worktree"}`;
  const originalPath = `${base}/original`;
  const modifiedPath = `${base}/modified`;

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-rail px-2">
        <div className="flex h-[26px] shrink-0 items-center gap-2 rounded-md border border-ink/[0.09] bg-ink/[0.05] px-2.5 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)]">
          <span className="font-mono text-[11px] text-ink/80">{name}</span>
          <span className="rounded bg-ink/[0.07] px-1.5 font-mono text-[9px] leading-4 text-ink/45">
            diff
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            title="Close diff"
            className="-mr-1 ml-0.5 flex size-4 items-center justify-center rounded text-ink/30 transition-colors duration-150 hover:bg-ink/10 hover:text-ink"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </div>

        <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[10px] text-ink/25">
          {segments.map((segment, index) => (
            <span
              key={`${segment}-${index}`}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 && (
                <ChevronRight
                  className="size-2.5 shrink-0 text-ink/15"
                  strokeWidth={2.5}
                />
              )}
              <span
                className={
                  index === segments.length - 1
                    ? "truncate text-ink/45"
                    : "shrink-0"
                }
              >
                {segment}
              </span>
            </span>
          ))}
        </div>

        <span className="ml-auto shrink-0 rounded border border-ink/[0.09] px-2 py-[3px] font-mono text-[10px] text-ink/40">
          {staged ? "HEAD → staged" : "HEAD → working tree"}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <DiffEditor
          original={original}
          modified={modified}
          originalModelPath={originalPath}
          modifiedModelPath={modifiedPath}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          language={languageForPath(path)}
          theme="nexium"
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
            fontSize: 13,
            lineHeight: 23,
            letterSpacing: 0.1,
            minimap: { enabled: false },
            padding: { top: 16, bottom: 40 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorWidth: 2,
            fontLigatures: true,
            automaticLayout: true,
            lineNumbersMinChars: 4,
            renderLineHighlight: "none",
            renderOverviewRuler: false,
            renderIndicators: true,
            ignoreTrimWhitespace: false,
            stickyScroll: { enabled: false },
            scrollbar: {
              verticalScrollbarSize: 12,
              horizontalScrollbarSize: 12,
              useShadows: false,
            },
            overviewRulerLanes: 0,
            guides: { indentation: true, highlightActiveIndentation: true },
          }}
          loading={
            <div className="flex h-full w-full items-center justify-center bg-app font-mono text-[11px] tracking-[0.14em] text-ink/25 uppercase">
              Loading diff
            </div>
          }
        />
      </div>
    </>
  );
}
