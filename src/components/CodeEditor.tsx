import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useRef } from "react";

import { selectionIntents } from "../lib/assistantPrompt";
import type { SelectionIntent } from "../lib/assistantPrompt";
import { modelUri } from "../lib/workspace";

export type CodeEditorHandle = {
  /** Scroll so the given source line sits at the top of the viewport. */
  scrollToLine: (line: number) => void;
  /** Run a built-in Monaco command, such as "undo" or "actions.find". */
  runAction: (id: string) => void;
};

/** What the editor's right-click actions can ask the assistant about. */
export type EditorAiRequest =
  | {
      scope: "selection";
      intent: SelectionIntent;
      text: string;
      startLine: number;
      endLine: number;
    }
  | { scope: "file" };

type CodeEditorProps = {
  path: string;
  language: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  /** Fires while the editor scrolls, with the first visible source line. */
  onLineChange?: (line: number) => void;
  /** Fires when the caret moves, for the status bar. */
  onCursorChange?: (line: number, column: number) => void;
  /** The right-click menu's AI entries hand the assistant a question. */
  onAskAi?: (request: EditorAiRequest) => void;
  ref?: Ref<CodeEditorHandle>;
};

export default function CodeEditor({
  path,
  language,
  value,
  onChange,
  onSave,
  onLineChange,
  onCursorChange,
  onAskAi,
  ref,
}: CodeEditorProps) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const lineRef = useRef(onLineChange);
  lineRef.current = onLineChange;

  const cursorRef = useRef(onCursorChange);
  cursorRef.current = onCursorChange;

  const askRef = useRef(onAskAi);
  askRef.current = onAskAi;

  const actionsRef = useRef<{ dispose: () => void }[]>([]);

  const instanceRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const listenerRef = useRef<{ dispose: () => void } | null>(null);
  const cursorListenerRef = useRef<{ dispose: () => void } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line) {
        const instance = instanceRef.current;

        if (!instance) {
          return;
        }

        instance.setScrollTop(
          Math.max(0, instance.getTopForLineNumber(Math.max(1, line))),
        );
      },
      runAction(id) {
        instanceRef.current?.getAction(id)?.run();
      },
    }),
    [],
  );

  useEffect(
    () => () => {
      actionsRef.current.forEach((action) => action.dispose());
      actionsRef.current = [];
      listenerRef.current?.dispose();
      listenerRef.current = null;
      cursorListenerRef.current?.dispose();
      cursorListenerRef.current = null;
      instanceRef.current = null;
    },
    [],
  );

  return (
    <Editor
      path={modelUri(path)}
      language={language}
      theme="nexium"
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onMount={(editor, monacoApi) => {
        instanceRef.current = editor;
        editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () =>
          saveRef.current?.(),
        );
        // Monaco draws its own context menu, so the AI entries belong to it.
        // Highlighting code swaps one generic question for a set of intents
        // (explain, refactor, find bugs, document); without a selection only
        // the file entry is left.
        actionsRef.current.forEach((action) => action.dispose());
        actionsRef.current = [
          ...selectionIntents.map((intent, index) =>
            editor.addAction({
              id: `nexium.ask-ai-${intent.id}`,
              label: intent.label,
              contextMenuGroupId: "navigation",
              contextMenuOrder: 1000 + index,
              precondition: "editorHasSelection",
              run: (instance) => {
                const model = instance.getModel();
                const selection = instance.getSelection();

                if (!model || !selection || selection.isEmpty()) {
                  return;
                }

                askRef.current?.({
                  scope: "selection",
                  intent: intent.id,
                  text: model.getValueInRange(selection),
                  startLine: selection.startLineNumber,
                  endLine: selection.endLineNumber,
                });
              },
            }),
          ),
          editor.addAction({
            id: "nexium.ask-ai-file",
            label: "Ask AI about this file",
            contextMenuGroupId: "navigation",
            contextMenuOrder: 1010,
            run: () => askRef.current?.({ scope: "file" }),
          }),
        ];
        listenerRef.current?.dispose();
        listenerRef.current = editor.onDidScrollChange(() => {
          lineRef.current?.(editor.getVisibleRanges()[0]?.startLineNumber ?? 1);
        });
        cursorListenerRef.current?.dispose();
        cursorListenerRef.current = editor.onDidChangeCursorPosition((event) => {
          cursorRef.current?.(event.position.lineNumber, event.position.column);
        });
      }}
      loading={
        <div className="flex h-full w-full items-center justify-center bg-app font-mono text-[11px] tracking-[0.14em] text-ink/25 uppercase">
          Loading editor
        </div>
      }
      options={{
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
        fontSize: 13,
        lineHeight: 23,
        letterSpacing: 0.1,
        minimap: { enabled: false },
        padding: { top: 20, bottom: 48 },
        renderLineHighlight: "all",
        renderLineHighlightOnlyWhenFocus: false,
        // Ghost text from the AI completion provider; Tab accepts it.
        inlineSuggest: { enabled: true },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        cursorWidth: 2,
        fontLigatures: true,
        automaticLayout: true,
        lineNumbersMinChars: 4,
        matchBrackets: "always",
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: false },
        stickyScroll: { enabled: false },
        scrollbar: {
          verticalScrollbarSize: 12,
          horizontalScrollbarSize: 12,
          useShadows: false,
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        guides: {
          indentation: true,
          highlightActiveIndentation: true,
          bracketPairs: false,
        },
      }}
    />
  );
}
