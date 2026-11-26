import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  Info,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import AboutDialog from "./components/AboutDialog";
import ActivityRail from "./components/ActivityRail";
import AppearanceSettings from "./components/AppearanceSettings";
import AssistantRail from "./components/AssistantRail";
import AiAssistant from "./components/AiAssistant";
import type { AssistantMessage } from "./components/AiAssistant";
import CodeEditor from "./components/CodeEditor";
import type {
  CodeEditorHandle,
  EditorAiRequest,
} from "./components/CodeEditor";
import ConfirmDialog from "./components/ConfirmDialog";
import DiffView from "./components/DiffView";
import Explorer from "./components/Explorer";
import FontPreview from "./components/FontPreview";
import FontsSettings from "./components/FontsSettings";
import ImagePreview from "./components/ImagePreview";
import MarkdownPreview from "./components/MarkdownPreview";
import type { MarkdownPreviewHandle } from "./components/MarkdownPreview";
import SourceControlPanel from "./components/SourceControlPanel";
import SettingsNav from "./components/SettingsNav";
import type { SettingsSection } from "./components/SettingsNav";
import SettingsPage from "./components/SettingsPage";
import SourceControlSettings from "./components/SourceControlSettings";
import SvgPreview from "./components/SvgPreview";
import TerminalPanel from "./components/TerminalPanel";
import TitleBarMenu from "./components/TitleBarMenu";
import WindowControls from "./components/WindowControls";
import type { AssistantSettings } from "./lib/assistantSettings";
import { generateCommitMessage } from "./lib/commitMessage";
import {
  loadAssistantSettings,
  saveAssistantSettings,
} from "./lib/assistantSettings";
import {
  commitAndSync,
  commitChanges,
  readGitFileDiff,
  readGitStatus,
  stageAll,
  stagePath,
  unstageAll,
  unstagePath,
} from "./lib/git";
import type { GitStatus } from "./lib/git";
import { pathPrompt, selectionPrompt } from "./lib/assistantPrompt";
import { setInlineCompletionModel } from "./lib/inlineCompletion";
import { languageForPath } from "./lib/languages";
import { isFontPath, isImagePath } from "./lib/media";
import { applyTheme, loadThemeId, saveThemeId } from "./lib/themes";
import { monaco } from "./lib/monacoSetup";
import { cancelAgent, runAgent } from "./lib/nim";
import type { AgentDelta, AgentStep, ChatMessage } from "./lib/nim";
import { isTauri, toError } from "./lib/tauriBridge";
import type { ExplorerNode, FolderNode } from "./lib/workspace";
import { modelUri } from "./lib/workspace";
import { registerWorkspaceSources } from "./lib/workspaceModels";
import {
  createEntry,
  deleteEntry,
  demoWorkspace,
  newProject,
  openFolder,
  readFile,
  readWorkspaceSources,
  refreshWorkspace,
  renameEntry,
  writeFile,
} from "./lib/workspaceFs";
import type { WorkspaceSnapshot } from "./lib/workspaceFs";
import {
  collectPaths,
  findNode,
  firstFilePath,
  insertNode,
  joinPath,
  migrateContents,
  omitPaths,
  parentPathOf,
  removeNode,
  renameNode,
} from "./lib/workspaceTree";

const MAX_CONTEXT_CHARS = 24_000;

/** The Rust client reports a dead connection when NVIDIA stays silent. */
function stalled(message: string): boolean {
  return /no data for \d+s|stopped responding \(no data/i.test(message);
}

function speedHint(id: string): number {
  return /flash|bolt|lightning|nano|mini|small|fast/i.test(id) ? 0 : 1;
}

/** Fastest verified model other than the one that just stalled. */
function fallbackModel(settings: AssistantSettings): string | null {
  const candidates = settings.workingModels.filter(
    (id) => id !== settings.model,
  );

  if (candidates.length === 0) {
    return null;
  }

  const ranked = [...candidates].sort((left, right) => {
    const leftMs = settings.latency[left] ?? Number.MAX_SAFE_INTEGER;
    const rightMs = settings.latency[right] ?? Number.MAX_SAFE_INTEGER;

    return (
      leftMs - rightMs ||
      speedHint(left) - speedHint(right) ||
      left.localeCompare(right)
    );
  });

  return ranked[0] ?? null;
}

export default function App() {
  const [tree, setTree] = useState<FolderNode | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [rootPath, setRootPath] = useState("");
  const [contents, setContents] = useState<Record<string, string>>({});
  const [activePath, setActivePath] = useState("");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [scmOpen, setScmOpen] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  // Opening a change replaces the editor with a read-only diff of that file.
  const [diff, setDiff] = useState<{
    path: string;
    staged: boolean;
    original: string;
    modified: string;
  } | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [deleteTarget, setDeleteTarget] = useState<{
    path: string;
    name: string;
    kind: "file" | "folder";
  } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const [explorerOpen, setExplorerOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  // The terminal is only created on first use; after that it stays mounted so
  // hiding it keeps the shell's scrollback and its working directory.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalUsed, setTerminalUsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [assistantFull, setAssistantFull] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<
    AssistantMessage[]
  >([]);
  const [assistantPending, setAssistantPending] = useState(false);
  // A prompt from a right-click action; the assistant composer takes it once.
  const [assistantSeed, setAssistantSeed] = useState<string | null>(null);
  const [live, setLive] = useState<{
    steps: AgentStep[];
    reasoning: string;
    text: string;
  } | null>(null);
  const [view, setView] = useState<"editor" | "settings">("editor");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const [themeId, setThemeId] = useState<string>(loadThemeId);
  const [settings, setSettings] = useState<AssistantSettings>(
    loadAssistantSettings,
  );
  const nextMessageId = useRef(1);
  const workspaceSources = useRef<Set<string>>(new Set());
  // Settings owns the whole window, so the assistant and the left panel step
  // aside and come back afterwards if they were open when the user went in.
  const assistantBeforeSettings = useRef(false);
  const leftPanelBeforeSettings = useRef<"explorer" | "source-control" | null>(
    null,
  );

  /** Replaces the editor state with a freshly opened or created project. */
  const applyWorkspace = useCallback(async (snapshot: WorkspaceSnapshot) => {
    setTree(snapshot.tree);
    setRootPath(snapshot.root);
    setWorkspaceKey((current) => current + 1);
    setContents({});
    setDirty({});
    setActivePath("");
    setNotice(null);

    // Give the TypeScript worker every source file, not just opened ones.
    const sources = await readWorkspaceSources();
    workspaceSources.current = new Set(registerWorkspaceSources(sources));
  }, []);

  const openFolderAction = useCallback(async () => {
    try {
      const snapshot = await openFolder();

      if (!snapshot) {
        return;
      }

      await applyWorkspace(snapshot);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not open that folder.");
    }
  }, [applyWorkspace]);

  const newProjectAction = useCallback(async () => {
    try {
      const snapshot = await newProject();

      if (!snapshot) {
        return;
      }

      await applyWorkspace(snapshot);
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Could not create that project.",
      );
    }
  }, [applyWorkspace]);

  // Ctrl+` toggles the terminal from anywhere. Capture runs before Monaco or
  // the terminal's own textarea can consume the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Backquote" ||
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setView("editor");
      setTerminalUsed(true);
      // Settings hides the panel without closing it, so asking for the
      // terminal there means show it rather than flip its hidden state.
      setTerminalOpen((open) => (view === "settings" ? true : !open));
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [view]);

  // In chat-only mode the assistant covers the window, so Escape is the way back.
  useEffect(() => {
    if (!assistantFull) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      // An overlay (explorer draft, context menu) may claim this Escape after
      // us, so the decision is made once the event has finished dispatching.
      window.setTimeout(() => {
        if (!event.defaultPrevented) {
          setAssistantFull(false);
        }
      }, 0);
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assistantFull]);

  useEffect(() => {
    applyTheme(themeId);
    saveThemeId(themeId);
  }, [themeId]);

  // Ghost-text completions use the assistant's verified key and model, so they
  // start working the moment a model is chosen and stop when the key is removed.
  useEffect(() => {
    setInlineCompletionModel(settings.apiKey, settings.model);
  }, [settings.apiKey, settings.model]);


  const openSettings = useCallback(() => {
    setAssistantFull(false);
    setView("settings");
  }, []);

  useEffect(() => {
    if (view === "settings") {
      // Captured from this render, before anything is closed.
      assistantBeforeSettings.current = assistantOpen;
      leftPanelBeforeSettings.current = scmOpen
        ? "source-control"
        : explorerOpen
          ? "explorer"
          : null;

      setAssistantOpen(false);
      setScmOpen(false);
      setExplorerOpen(false);
      return;
    }

    if (assistantBeforeSettings.current) {
      assistantBeforeSettings.current = false;
      setAssistantOpen(true);
    }

    if (leftPanelBeforeSettings.current === "source-control") {
      setScmOpen(true);
    }

    if (leftPanelBeforeSettings.current === "explorer") {
      setExplorerOpen(true);
    }

    leftPanelBeforeSettings.current = null;
    // Only entering and leaving settings should move these panels.
  }, [view]);

  // The browser build has no filesystem, so it starts on the sample project.
  useEffect(() => {
    if (isTauri()) {
      return;
    }

    setTree(demoWorkspace().tree);
  }, []);

  const handleSelect = useCallback(
    async (path: string) => {
      setDiff(null);
      setActivePath(path);

      // Images and fonts are drawn from their bytes, so there is no text to load.
      if (isImagePath(path) || isFontPath(path)) {
        return;
      }

      if (contents[path] !== undefined) {
        return;
      }

      setLoadingPath(path);

      try {
        const text = await readFile(path);
        setContents((current) => ({ ...current, [path]: text }));
        setNotice(null);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Could not open that file.");
      } finally {
        setLoadingPath((current) => (current === path ? null : current));
      }
    },
    [contents],
  );

  const handleChange = useCallback(
    (next: string) => {
      setContents((current) => ({ ...current, [activePath]: next }));
      setDirty((current) => ({ ...current, [activePath]: true }));
    },
    [activePath],
  );

  /** Runs one git action and keeps the last status it returned. */
  const applyGit = useCallback(
    async (action: () => Promise<GitStatus>): Promise<boolean> => {
      setGitBusy(true);

      try {
        setGit(await action());
        setGitError(null);

        return true;
      } catch (cause) {
        setGitError(cause instanceof Error ? cause.message : "Git failed.");

        return false;
      } finally {
        setGitBusy(false);
      }
    },
    [],
  );

  const refreshGit = useCallback(() => {
    if (!tree) {
      return;
    }

    void applyGit(readGitStatus);
  }, [applyGit, tree]);

  const refreshGitRef = useRef(refreshGit);
  refreshGitRef.current = refreshGit;

  const handleOpenDiff = useCallback(async (path: string, staged: boolean) => {
    try {
      const fileDiff = await readGitFileDiff(path, staged);
      setDiff({ path, staged, ...fileDiff });
      setNotice(null);
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "That change could not be read.",
      );
    }
  }, []);

  const handleStage = useCallback(
    (path: string) => void applyGit(() => stagePath(path)),
    [applyGit],
  );

  const handleUnstage = useCallback(
    (path: string) => void applyGit(() => unstagePath(path)),
    [applyGit],
  );

  const handleStageAll = useCallback(
    () => void applyGit(stageAll),
    [applyGit],
  );

  const handleUnstageAll = useCallback(
    () => void applyGit(unstageAll),
    [applyGit],
  );

  const handleCommit = useCallback(
    (message: string) => applyGit(() => commitChanges(message)),
    [applyGit],
  );

  const handleCommitAndSync = useCallback(
    async (message: string) => {
      const committed = await applyGit(() => commitAndSync(message));

      if (!committed) {
        // The commit lands before the push, so the list can change on failure.
        try {
          setGit(await readGitStatus());
        } catch {
          // The sync error stays on screen; only the list would be stale.
        }
      }

      return committed;
    },
    [applyGit],
  );

  // The commit message button uses the assistant's selected model.
  const handleGenerateMessage = useCallback(
    () => generateCommitMessage(settings.apiKey, settings.model, git?.changes ?? []),
    [git, settings.apiKey, settings.model],
  );

  // Keep the status bar branch and the change list current.
  useEffect(() => {
    if (tree) {
      refreshGit();
    }
  }, [refreshGit, tree]);

  const saveActive = useCallback(async () => {
    const text = contents[activePath];

    if (!activePath || text === undefined) {
      return;
    }

    try {
      await writeFile(activePath, text);
      setDirty((current) => ({ ...current, [activePath]: false }));
      setNotice(null);

      if (scmOpen) {
        refreshGitRef.current();
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save.");
    }
  }, [activePath, contents]);

  // Ctrl/Cmd+S outside the editor (the editor handles it via Monaco).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveActive]);

  const handleCreate = useCallback(
    async (parentPath: string, name: string, kind: "file" | "folder") => {
      try {
        const path = await createEntry(parentPath, name, kind);
        const node: ExplorerNode =
          kind === "folder"
            ? { kind: "folder", name, path, children: [] }
            : { kind: "file", name, path };

        setTree((current) =>
          current
            ? {
                ...current,
                children: insertNode(current.children, parentPath, node),
              }
            : current,
        );

        if (kind === "file") {
          setContents((current) => ({ ...current, [path]: "" }));
          setActivePath(path);
          workspaceSources.current.add(path);
        }

        setNotice(null);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Could not create that.");
      }
    },
    [],
  );

  const handleRename = useCallback(
    async (path: string, name: string) => {
      if (!tree) {
        return;
      }

      const nextPath = joinPath(parentPathOf(path), name);

      try {
        await renameEntry(path, nextPath);

        const { nodes, moved } = renameNode(tree.children, path, name);

        setTree({ ...tree, children: nodes });
        setContents((current) => migrateContents(current, moved));
        setActivePath((current) => moved.get(current) ?? current);
        setDirty((current) => {
          const next = { ...current };

          for (const [from, to] of moved) {
            next[to] = next[from];
            delete next[from];
          }

          return next;
        });

        workspaceSources.current.delete(path);
        workspaceSources.current.add(nextPath);
        setNotice(null);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Could not rename.");
      }
    },
    [tree],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!tree) {
        return;
      }

      const target = findNode(tree.children, path);

      if (!target) {
        return;
      }

      try {
        await deleteEntry(path);

        const removed = collectPaths(target);
        const nodes = removeNode(tree.children, path);

        for (const removedPath of removed) {
          workspaceSources.current.delete(removedPath);
        }

        setTree({ ...tree, children: nodes });
        setContents((current) => omitPaths(current, removed));
        setDirty((current) => {
          const next = { ...current };

          for (const removedPath of removed) {
            delete next[removedPath];
          }

          return next;
        });
        setActivePath((current) =>
          removed.includes(current) ? (firstFilePath(nodes) ?? "") : current,
        );
        setNotice(null);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Could not delete.");
      }
    },
    [tree],
  );

  /** Deleting is permanent, so the explorer only asks; this arms the dialog. */
  const requestDelete = useCallback(
    (path: string) => {
      const node = tree ? findNode(tree.children, path) : undefined;

      setDeleteTarget({
        path,
        name: node?.name ?? path.split("/").pop() ?? path,
        kind: node?.kind === "folder" ? "folder" : "file",
      });
    },
    [tree],
  );

  const handleSaveSettings = useCallback((next: AssistantSettings) => {
    setSettings(next);
    saveAssistantSettings(next);
  }, []);

  const handleSelectModel = useCallback(
    (id: string) => {
      if (id === settings.model) {
        return;
      }

      handleSaveSettings({ ...settings, model: id });
    },
    [handleSaveSettings, settings],
  );

  // The diff's models outlive its widget by a tick; once the diff is closed the
  // widget is gone, so they can be disposed without tripping Monaco.
  useEffect(() => {
    if (diff) {
      return;
    }

    const stale = monaco.editor
      .getModels()
      .filter((model) => model.uri.toString().startsWith("inmemory://nexium-diff/"));

    if (stale.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      for (const model of stale) {
        if (!model.isDisposed()) {
          model.dispose();
        }
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [diff]);

  const activeContent = activePath ? contents[activePath] : undefined;
  const contextPath = activeContent === undefined ? null : activePath;

  /** Open the assistant with a ready prompt in its composer. */
  const askAssistant = useCallback((prompt: string) => {
    setAssistantSeed(prompt);
    setAssistantOpen(true);
  }, []);

  const consumeAssistantSeed = useCallback(() => setAssistantSeed(null), []);

  const handleAskAboutEditor = useCallback(
    (request: EditorAiRequest) => {
      if (!activePath) {
        return;
      }

      askAssistant(
        request.scope === "selection"
          ? selectionPrompt({
              path: activePath,
              language: languageForPath(activePath),
              intent: request.intent,
              text: request.text,
              startLine: request.startLine,
              endLine: request.endLine,
            })
          : pathPrompt(activePath),
      );
    },
    [activePath, askAssistant],
  );

  const handleSendPrompt = useCallback(
    async (text: string) => {
      const userId = nextMessageId.current;
      nextMessageId.current += 1;

      setAssistantMessages((current) => [
        ...current,
        { id: userId, role: "user", text },
      ]);

      if (!settings.apiKey || !settings.model) {
        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            error: true,
            text: "Connect NVIDIA NIM in Settings first.",
          },
        ]);
        return;
      }

      const system: ChatMessage[] =
        contextPath && activeContent !== undefined
          ? [
              {
                role: "system",
                content: `You are the assistant inside Nexium Studio, a local code editor. The user has ${contextPath} open. Help with this file when relevant and keep answers concise.\n\nFile: ${contextPath}\n\`\`\`\n${activeContent.slice(0, MAX_CONTEXT_CHARS)}\n\`\`\``,
              },
            ]
          : [];

      const history: ChatMessage[] = [
        ...system,
        ...assistantMessages
          .filter((message) => !message.error)
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.text,
          })),
        { role: "user", content: text },
      ];

      setAssistantPending(true);
      setLive({ steps: [], reasoning: "", text: "" });

      try {
        const reply = await runAgent(
          settings.apiKey,
          settings.model,
          history,
        );

        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            text: reply.text,
            reasoning: reply.reasoning,
            steps: reply.steps,
          },
        ]);
      } catch (cause) {
        const failure = toError(cause, "The request failed.");
        const stopped = failure.message === "Stopped.";
        const alternative = stopped ? null : fallbackModel(settings);

        // A silent, very large model would otherwise dead-end the request.
        if (alternative && stalled(failure.message)) {
          const note: AgentStep = {
            id: 0,
            kind: "notice",
            title: `${settings.model} stopped responding — retried with ${alternative}`,
            status: "done",
          };

          setLive({ steps: [note], reasoning: "", text: "" });

          try {
            const reply = await runAgent(
              settings.apiKey,
              alternative,
              history,
            );

            setAssistantMessages((current) => [
              ...current,
              {
                id: nextMessageId.current++,
                role: "assistant",
                text: reply.text,
                reasoning: reply.reasoning,
                steps: [note, ...reply.steps],
              },
            ]);
            return;
          } catch (retryCause) {
            const retryFailure = toError(retryCause, "The request failed.");
            const retryStopped = retryFailure.message === "Stopped.";

            setAssistantMessages((current) => [
              ...current,
              {
                id: nextMessageId.current++,
                role: "assistant",
                error: !retryStopped,
                text: retryFailure.message,
                steps: [note],
              },
            ]);
            return;
          }
        }

        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            error: !stopped,
            text: failure.message,
          },
        ]);
      } finally {
        setAssistantPending(false);
        setLive(null);
      }
    },
    [activeContent, assistantMessages, contextPath, settings],
  );

  // Tool steps and streamed tokens arrive as events while the agent works.
  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let active = true;
    const stops: (() => void)[] = [];

    const attach = <T,>(event: string, handle: (payload: T) => void) => {
      void listen<T>(event, (incoming) => handle(incoming.payload)).then(
        (unlisten) => {
          if (active) {
            stops.push(unlisten);
          } else {
            unlisten();
          }
        },
      );
    };

    attach<AgentStep>("agent-step", (step) => {
      setLive((current) => {
        if (!current) {
          return current;
        }

        const steps = [...current.steps];
        const index = steps.findIndex((entry) => entry.id === step.id);

        if (index >= 0) {
          steps[index] = step;
        } else {
          steps.push(step);
        }

        return { ...current, steps };
      });
    });

    attach<AgentDelta>("agent-delta", (delta) => {
      setLive((current) => {
        if (!current) {
          return current;
        }

        return delta.kind === "reasoning"
          ? { ...current, reasoning: current.reasoning + delta.text }
          : { ...current, text: current.text + delta.text };
      });
    });

    return () => {
      active = false;

      for (const stop of stops) {
        stop();
      }
    };
  }, []);

  // The assistant can rewrite a file through its tools; keep the editor in sync.
  const contentsRef = useRef<Record<string, string>>({});
  contentsRef.current = contents;
  const rootRef = useRef("");
  rootRef.current = rootPath;

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let active = true;
    let stop: (() => void) | null = null;

    void listen<string>("workspace:file-changed", (event) => {
      const path = event.payload;

      // New files only appear in the explorer after a fresh listing.
      void refreshWorkspace(rootRef.current)
        .then((snapshot) => setTree(snapshot.tree))
        .catch(() => {
          // The folder may have been closed; nothing to refresh.
        });

      // A written file is a source-control change as well.
      refreshGitRef.current();

      if (contentsRef.current[path] === undefined) {
        return;
      }

      void readFile(path)
        .then((text) => {
          setContents((current) => ({ ...current, [path]: text }));
          setDirty((current) => ({ ...current, [path]: false }));
        })
        .catch(() => {
          // The file may have been renamed away; keep what the editor has.
        });
    }).then((unlisten) => {
      if (active) {
        stop = unlisten;
      } else {
        unlisten();
      }
    });

    return () => {
      active = false;
      stop?.();
    };
  }, []);

  // Renaming or deleting a file leaves its old Monaco model behind; drop any
  // model whose file is neither open nor listed in the tree. Everything the
  // tree lists is kept, so workspace models registered up front survive a
  // reload and relative imports keep resolving.
  useEffect(() => {
    // Before a workspace is known there is nothing to compare against, and the
    // sample models would look stale, so leave them alone until a tree exists.
    if (!tree) {
      return;
    }

    const keep = new Set(Object.keys(contents).map(modelUri));

    for (const path of workspaceSources.current) {
      keep.add(modelUri(path));
    }

    const collect = (node: FolderNode | null) => {
      if (!node) {
        return;
      }

      for (const child of node.children ?? []) {
        if (child.kind === "folder") {
          collect(child);
        } else {
          keep.add(modelUri(child.path));
        }
      }
    };

    collect(tree);

    for (const model of monaco.editor.getModels()) {
      // The diff editor keeps its own `inmemory://` models, which are not files
      // in this workspace, so only project files are pruned here.
      if (model.uri.scheme === "file" && !keep.has(model.uri.toString())) {
        model.dispose();
      }
    }
  }, [contents, tree]);

  const isDirty = Boolean(activePath && dirty[activePath]);
  const activeName = activePath.split("/").pop() ?? activePath;
  const pathSegments = activePath ? activePath.split("/") : [];
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(activePath);
  const isSvg = /\.svg$/i.test(activePath);
  const isImage = isImagePath(activePath);
  const isFont = isFontPath(activePath);
  // Neither has text to edit, so the editor area shows the bytes instead.
  const isBinaryPreview = isImage || isFont;

  // The preview and the editor follow each other by source line. The guard
  // windows below stop the two from echoing each other in a loop.
  const editorRef = useRef<CodeEditorHandle>(null);
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  const editorSyncUntil = useRef(0);
  const previewSyncUntil = useRef(0);

  const handleEditorLine = useCallback((line: number) => {
    // Monaco animates programmatic scrolls, so its echoes are ignored until the
    // requested position has settled.
    if (performance.now() < editorSyncUntil.current) {
      return;
    }

    previewSyncUntil.current = performance.now() + 160;
    previewRef.current?.scrollToLine(line);
  }, []);

  const handlePreviewLine = useCallback((line: number) => {
    if (performance.now() < previewSyncUntil.current) {
      return;
    }

    editorSyncUntil.current = performance.now() + 220;
    editorRef.current?.scrollToLine(line);
  }, []);
  const configured = Boolean(settings.apiKey && settings.model);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app text-ink">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-app pl-3 pr-0"
      >
        <div
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2.5"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-b from-ink/[0.11] to-ink/[0.03] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_8%,transparent)] ring-1 ring-ink/10">
            <img src="/nexium.svg" alt="" className="size-4" />
          </span>
          <span data-tauri-drag-region className="flex items-baseline gap-1">
            <span
              data-tauri-drag-region
              className="text-[13px] font-semibold tracking-[-0.01em] text-ink/90"
            >
              Nexium
            </span>
            <span
              data-tauri-drag-region
              className="text-[13px] font-medium tracking-[-0.01em] text-ink/30"
            >
              Studio
            </span>
          </span>
        </div>

        <span aria-hidden className="h-5 w-px bg-ink/[0.06]" />

        <div className="flex min-w-0 items-center gap-2">
          <TitleBarMenu
            projectName={tree?.name ?? "no folder"}
            editDisabled={!contextPath || diff !== null}
            explorerOpen={explorerOpen}
            sourceControlOpen={scmOpen}
            assistantOpen={assistantOpen}
            previewOpen={previewOpen}
            previewAvailable={isMarkdown || isSvg}
            onToggleExplorer={() => {
              // The two left views share one slot, so asking for the explorer
              // closes Source Control, and Settings hands the slot back.
              leftPanelBeforeSettings.current = null;
              setView("editor");

              if (scmOpen) {
                setScmOpen(false);
                setExplorerOpen(true);
                return;
              }

              setExplorerOpen((open) => !open);
            }}
            onToggleSourceControl={() => {
              leftPanelBeforeSettings.current = null;
              setView("editor");
              setScmOpen((open) => !open);
            }}
            onToggleAssistant={() => setAssistantOpen((open) => !open)}
            onTogglePreview={() => setPreviewOpen((open) => !open)}
            onNewProject={() => void newProjectAction()}
            onOpenProject={() => void openFolderAction()}
            onRevealExplorer={() => {
              // Settings owns the left slot, so revealing also leaves it, and
              // the captured panel state must not undo this on the way out.
              leftPanelBeforeSettings.current = null;
              setView("editor");
              setScmOpen(false);
              setExplorerOpen(true);
            }}
            onAbout={() => setAboutOpen(true)}
            onUndo={() => editorRef.current?.runAction("undo")}
            onRedo={() => editorRef.current?.runAction("redo")}
            onFind={() => editorRef.current?.runAction("actions.find")}
            onReplace={() =>
              editorRef.current?.runAction(
                "editor.action.startFindReplaceAction",
              )
            }
          />

          {activePath && (
            <span
              data-tauri-drag-region
              className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-ink/30"
            >
              <ChevronRight
                className="size-3 shrink-0 text-ink/15"
                strokeWidth={2}
              />
              <span data-tauri-drag-region className="truncate">
                {activePath}
              </span>
              {isDirty && (
                <span
                  title="Unsaved changes"
                  className="ml-1 size-1.5 shrink-0 rounded-full bg-ink/70"
                />
              )}
            </span>
          )}
        </div>

        <div className="ml-auto flex h-full shrink-0 items-stretch">
          <WindowControls />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {assistantFull ? (
          <>
            {explorerOpen && tree && (
              <Explorer
                key={workspaceKey}
                tree={tree}
                activePath={activePath}
                onSelect={(path) => void handleSelect(path)}
                onAskAi={(path, kind) => askAssistant(pathPrompt(path, kind))}
                onCreate={handleCreate}
                onRename={handleRename}
                onDelete={requestDelete}
                onOpenFolder={() => void openFolderAction()}
                onHide={() => setExplorerOpen(false)}
              />
            )}
            <AiAssistant
              messages={assistantMessages}
              configured={configured}
              model={settings.model}
              pending={assistantPending}
              live={live}
              contextPath={contextPath}
              models={settings.workingModels}
              latency={settings.latency}
              onSelectModel={handleSelectModel}
              explorerOpen={explorerOpen}
              onToggleExplorer={() => setExplorerOpen((open) => !open)}
              fullscreen
              onToggleFullscreen={() => setAssistantFull(false)}
              onSend={handleSendPrompt}
              seed={assistantSeed}
              onSeedConsumed={consumeAssistantSeed}
              onStop={() => void cancelAgent()}
              onOpenSettings={openSettings}
              onHide={() => {
                setAssistantFull(false);
                setAssistantOpen(false);
              }}
            />
          </>
        ) : (
          <>
        <ActivityRail
          explorerOpen={explorerOpen && !scmOpen}
          sourceControlOpen={scmOpen}
          settingsOpen={view === "settings"}
          onToggleExplorer={() => {
            // The two left views share one slot; asking for the explorer wins.
            // Settings owns that slot too, so leaving it restores the editor.
            // A deliberate rail click also replaces what settings would restore.
            leftPanelBeforeSettings.current = null;
            setView("editor");

            if (scmOpen) {
              setScmOpen(false);
              setExplorerOpen(true);
              return;
            }

            setExplorerOpen((open) => !open);
          }}
          onToggleSourceControl={() => {
            leftPanelBeforeSettings.current = null;
            setView("editor");
            setScmOpen((open) => !open);
          }}
          onToggleSettings={() =>
            setView((current) =>
              current === "settings" ? "editor" : "settings",
            )
          }
        />

        {view === "settings" ? (
          <SettingsNav
            section={settingsSection}
            onSelect={setSettingsSection}
            onClose={() => setView("editor")}
          />
        ) : scmOpen ? (
          <SourceControlPanel
            status={git}
            busy={gitBusy}
            error={gitError}
            onRefresh={refreshGit}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onStageAll={handleStageAll}
            onUnstageAll={handleUnstageAll}
            onCommit={handleCommit}
            onCommitAndSync={handleCommitAndSync}
            onGenerateMessage={handleGenerateMessage}
            canGenerate={Boolean(settings.apiKey && settings.model)}
            onSelect={(path, staged) => void handleOpenDiff(path, staged)}
            onHide={() => setScmOpen(false)}
          />
        ) : explorerOpen && tree ? (
          <Explorer
            key={workspaceKey}
            tree={tree}
            activePath={activePath}
            onSelect={(path) => void handleSelect(path)}
            onAskAi={(path, kind) => askAssistant(pathPrompt(path, kind))}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={requestDelete}
            onOpenFolder={() => void openFolderAction()}
            onHide={() => setExplorerOpen(false)}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col bg-app">
          {view === "settings" ? (
            settingsSection === "appearance" ? (
              <AppearanceSettings value={themeId} onChange={setThemeId} />
            ) : settingsSection === "fonts" ? (
              <FontsSettings />
            ) : settingsSection === "assistant" ? (
              <SettingsPage
                settings={settings}
                onSave={handleSaveSettings}
              />
            ) : (
              <SourceControlSettings />
            )
          ) : !tree ? (
            <div className="relative flex h-full flex-col items-center justify-center gap-5 px-8">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,color-mix(in_srgb,var(--color-ink)_5%,transparent),transparent_70%)]"
              />
              <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-b from-ink/[0.08] to-ink/[0.02] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)] ring-1 ring-ink/[0.08]">
                <FolderOpen className="size-5 text-ink/35" strokeWidth={1.5} />
              </span>
              <div className="text-center">
                <p className="text-[15px] font-medium tracking-[-0.01em] text-ink/80">
                  No folder open
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink/35">
                  Open a folder to browse, edit and let the assistant work on
                  its files.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void openFolderAction()}
                className="rounded-lg bg-ink px-3.5 py-2 text-[12px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
              >
                Open folder
              </button>
              {notice && (
                <p className="max-w-md text-center text-[11px] text-ink/40">
                  {notice}
                </p>
              )}
            </div>
          ) : diff ? (
            <DiffView
              path={diff.path}
              staged={diff.staged}
              original={diff.original}
              modified={diff.modified}
              onClose={() => setDiff(null)}
            />
          ) : loadingPath === activePath ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink/25">
                Opening
              </span>
              <span className="max-w-sm truncate font-mono text-[12px] text-ink/45">
                {activePath}
              </span>
            </div>
          ) : activeContent === undefined && !isBinaryPreview ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <FileText className="size-5 text-ink/20" strokeWidth={1.5} />
              <p className="text-[12px] text-ink/30">
                Select a file in the explorer
              </p>
            </div>
          ) : (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-rail px-2">
                <div className="flex h-[26px] shrink-0 items-center gap-2 rounded-md border border-ink/[0.09] bg-ink/[0.05] px-2.5 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)]">
                  <span className="font-mono text-[11px] text-ink/80">
                    {activeName}
                  </span>
                  {isDirty && (
                    <span
                      title="Unsaved changes"
                      className="size-1.5 rounded-full bg-ink/70"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setActivePath("")}
                    aria-label="Close file"
                    title="Close file"
                    className="-mr-1 ml-0.5 flex size-4 items-center justify-center rounded text-ink/30 transition-colors duration-150 hover:bg-ink/10 hover:text-ink"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </div>

                <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[10px] text-ink/25">
                  {pathSegments.length > 1 &&
                    pathSegments.map((segment, index) => (
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
                          index === pathSegments.length - 1
                            ? "truncate text-ink/45"
                            : "shrink-0"
                        }
                      >
                          {segment}
                        </span>
                      </span>
                    ))}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {!isBinaryPreview && (
                  <>
                  {(isMarkdown || isSvg) && (
                    <>
                      <button
                        type="button"
                        onClick={() => setPreviewOpen((open) => !open)}
                        aria-pressed={previewOpen}
                        title={previewOpen ? "Hide preview" : "Show preview"}
                        className={`flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors duration-150 ${
                          previewOpen
                            ? "border-ink/15 bg-ink/[0.06] text-ink/80"
                            : "border-transparent text-ink/40 hover:bg-ink/[0.05] hover:text-ink/70"
                        }`}
                      >
                        <Eye className="size-3" strokeWidth={1.75} />
                        Preview
                      </button>
                      <span aria-hidden className="h-4 w-px bg-ink/[0.08]" />
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => void saveActive()}
                    disabled={!isDirty}
                    title="Save (Ctrl/Cmd+S)"
                    className="flex h-6 items-center gap-1.5 rounded-md border border-ink/10 bg-ink/[0.03] px-2 text-[11px] text-ink/60 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.06] hover:text-ink disabled:border-transparent disabled:bg-transparent disabled:text-ink/20"
                  >
                    <Save className="size-3" strokeWidth={1.8} />
                    Save
                    <kbd className="ml-0.5 rounded border border-ink/[0.09] px-1 text-[8.5px] leading-[14px] text-ink/30">
                      ⌘S
                    </kbd>
                  </button>
                  </>
                  )}
                </div>
              </div>
              <div className="flex min-h-0 flex-1">
                {isImage ? (
                  <div className="min-w-0 flex-1">
                    <ImagePreview path={activePath} />
                  </div>
                ) : isFont ? (
                  <div className="min-w-0 flex-1">
                    <FontPreview path={activePath} />
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <CodeEditor
                      ref={editorRef}
                      path={activePath}
                      language={languageForPath(activePath)}
                      value={activeContent ?? ""}
                      onChange={handleChange}
                      onSave={() => void saveActive()}
                      onLineChange={handleEditorLine}
                      onAskAi={handleAskAboutEditor}
                      onCursorChange={(line, column) =>
                        setCursor({ line, column })
                      }
                    />
                  </div>
                )}
                {isMarkdown && previewOpen && (
                  <div className="min-h-0 w-[46%] min-w-[300px] shrink-0">
                    <MarkdownPreview
                      ref={previewRef}
                      path={activePath}
                      text={activeContent ?? ""}
                      onLineChange={handlePreviewLine}
                    />
                  </div>
                )}
                {isSvg && previewOpen && (
                  <div className="min-h-0 w-[46%] min-w-[300px] shrink-0">
                    <SvgPreview path={activePath} text={activeContent ?? ""} />
                  </div>
                )}
              </div>
            </>
          )}

          {terminalUsed && (
            <TerminalPanel
              active={terminalOpen && view !== "settings"}
              themeId={themeId}
              onHide={() => setTerminalOpen(false)}
            />
          )}
        </div>

        {assistantOpen && view !== "settings" && (
          <AiAssistant
            messages={assistantMessages}
            configured={Boolean(settings.apiKey && settings.model)}
            model={settings.model}
            pending={assistantPending}
            live={live}
            contextPath={contextPath}
            models={settings.workingModels}
            latency={settings.latency}
            onSelectModel={handleSelectModel}
            explorerOpen={explorerOpen}
            onToggleExplorer={() => setExplorerOpen((open) => !open)}
            fullscreen={false}
            onToggleFullscreen={() => {
              setAssistantOpen(true);
              setAssistantFull(true);
            }}
            onSend={handleSendPrompt}
            seed={assistantSeed}
            onSeedConsumed={consumeAssistantSeed}
            onStop={() => void cancelAgent()}
            onOpenSettings={openSettings}
                onHide={() => setAssistantOpen(false)}
              />
            )}

        {view !== "settings" && (
          <AssistantRail
            assistantOpen={assistantOpen}
            onToggleAssistant={() => setAssistantOpen((open) => !open)}
          />
        )}
          </>
        )}
      </div>

      {!assistantFull && (
      <footer className="flex h-6 shrink-0 items-stretch border-t border-line bg-app text-[10.5px]">
        {notice && (
          <span
            title={notice}
            className="flex max-w-[24rem] items-center gap-1.5 px-2.5 text-ink/45"
          >
            <Info className="size-3 shrink-0 text-ink/30" strokeWidth={1.75} />
            <span className="truncate">{notice}</span>
          </span>
        )}

        <button
          type="button"
          onClick={() => setScmOpen(true)}
          title="Source control"
          className="flex max-w-[16rem] items-center gap-1.5 border-l border-line px-2.5 text-ink/40 transition-colors duration-150 first:border-l-0 hover:bg-ink/[0.06] hover:text-ink/80"
        >
          <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {!tree
              ? "no folder"
              : git?.isRepo
                ? git.branch
                : "no repository"}
          </span>
          {git?.isRepo && git.changes.length > 0 && (
            <span className="rounded bg-ink/[0.08] px-1 font-mono text-[9px] leading-4 text-ink/50">
              {git.changes.length}
            </span>
          )}
        </button>

        <span className="flex min-w-0 flex-1 items-center border-l border-line px-2.5">
          <span className="min-w-0 truncate font-mono text-[10px] text-ink/25">
            {activePath || "no file open"}
          </span>
        </span>

        <span className="flex items-center border-l border-line px-2.5 uppercase tracking-[0.12em] text-ink/30">
          {isImage
            ? "image"
            : activePath
              ? languageForPath(activePath)
              : "plain text"}
        </span>

        {activePath && !isImage && (
          <span className="flex items-center gap-1 border-l border-line px-2.5 font-mono text-[10px] text-ink/30">
            <span>Ln {cursor.line}</span>
            <span aria-hidden className="text-ink/15">
              ,
            </span>
            <span>Col {cursor.column}</span>
          </span>
        )}

        <span className="flex items-center border-l border-line px-2.5 font-mono text-[10px] text-ink/25">
          UTF-8
        </span>

        <button
          type="button"
          onClick={() => setView("settings")}
          title="Assistant model"
          className="flex max-w-[18rem] items-center gap-1.5 border-l border-line px-2.5 text-ink/40 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${configured ? "bg-ink/70" : "bg-ink/20"}`}
          />
          <span className="truncate font-mono text-[10px]">
            {settings.model || "no model"}
          </span>
        </button>
      </footer>
      )}

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {deleteTarget && (
        <ConfirmDialog
          title={
            deleteTarget.kind === "folder"
              ? `Delete the folder “${deleteTarget.name}”?`
              : `Delete the file “${deleteTarget.name}”?`
          }
          description={
            deleteTarget.kind === "folder"
              ? "The folder and everything inside it will be permanently removed from disk. This cannot be undone."
              : "The file will be permanently removed from disk. This cannot be undone."
          }
          confirmLabel="Delete permanently"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void handleDelete(target.path);
          }}
        />
      )}
    </div>
  );
}
