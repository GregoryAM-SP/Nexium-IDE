import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  Download,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  Info,
  LoaderCircle,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AboutDialog from "./components/AboutDialog";
import ActivityRail from "./components/ActivityRail";
import AppearanceSettings from "./components/AppearanceSettings";
import AssistantRail from "./components/AssistantRail";
import AiAssistant from "./components/AiAssistant";
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
import GradlePanel from "./components/GradlePanel";
import ProjectSettingsDialog from "./components/ProjectSettingsDialog";
import ImagePreview from "./components/ImagePreview";
import MarkdownPreview from "./components/MarkdownPreview";
import type { MarkdownPreviewHandle } from "./components/MarkdownPreview";
import SourceControlPanel from "./components/SourceControlPanel";
import SettingsNav from "./components/SettingsNav";
import type { SettingsSection } from "./components/SettingsNav";
import ProvidersSettings from "./components/ProvidersSettings";
import SourceControlSettings from "./components/SourceControlSettings";
import SvgPreview from "./components/SvgPreview";
import TerminalPanel from "./components/TerminalPanel";
import WebPreviewPanel from "./components/WebPreviewPanel";
import TitleBarMenu from "./components/TitleBarMenu";
import WindowControls from "./components/WindowControls";
import type { AssistantSettings, ModelRef } from "./lib/assistantSettings";
import { generateCommitMessage } from "./lib/commitMessage";
import {
  loadAssistantSettings,
  contextWindowFor,
  loadStoredKeys,
  modelOptions,
  saveAssistantSettings,
  sameModel,
  targetFor,
} from "./lib/assistantSettings";
import {
  commitAndSync,
  commitChanges,
  readGitFileDiff,
  readGitStatus,
  readGitTags,
  createGitTag,
  pushGitTag,
  deleteGitTag,
  stageAll,
  stagePath,
  unstageAll,
  unstagePath,
} from "./lib/git";
import type { GitStatus, GitTag } from "./lib/git";
import { pathPrompt, selectionPrompt } from "./lib/assistantPrompt";
import {
  appendDelta,
  finishBlocks,
  historyContent,
  upsertStep,
} from "./lib/assistantMessages";
import {
  CONDENSE_AT,
  condenseRequest,
  contextUsage,
  estimateTokens,
  formatTokens,
  liveMessages,
  messagesToCondense,
  messagesToKeep,
  summaryMessage,
} from "./lib/contextBudget";
import type { CondensedHistory } from "./lib/contextBudget";
import type {
  AssistantMessage,
  MessageBlock,
} from "./lib/assistantMessages";
import {
  detectGradle,
  gradleCommand,
  isGradleScript,
  queryGradleTasks,
} from "./lib/gradle";
import type { GradleInfo, GradleProject, GradleTask } from "./lib/gradle";
import { loadGradleJvm, saveGradleJvm } from "./lib/gradleSettings";
import { useWebPreview } from "./lib/useWebPreview";
import { affectsWebDetection, installCommand } from "./lib/web";
import type { WebApp } from "./lib/web";
import { setInlineCompletionModel } from "./lib/inlineCompletion";
import { languageForPath } from "./lib/languages";
import { isFontPath, isImagePath } from "./lib/media";
import { applyTheme, loadThemeId, saveThemeId } from "./lib/themes";
import { monaco } from "./lib/monacoSetup";
import { cancelAgent, chat, decideChange, runAgent } from "./lib/llm";
import type {
  AgentDelta,
  AgentStep,
  ApprovalRequest,
  ChatMessage,
} from "./lib/llm";
import { isTauri, toError } from "./lib/tauriBridge";
import {
  checkForUpdates,
  installNow,
  onUpdateState,
  startAutoUpdates,
  updateState,
} from "./lib/updater";
import type { UpdateState } from "./lib/updater";
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
const AUTO_APPROVE_KEY = "nexium.assistant.autoApprove";

/** The Rust client reports a dead connection when a provider stays silent. */
function stalled(message: string): boolean {
  return /no data for \d+s|stopped responding \(no data/i.test(message);
}

/**
 * Folds the task list Gradle reported into the statically detected projects.
 * Gradle is authoritative for which tasks exist; the detected kind is kept
 * where Gradle only files a task under "other".
 */
function mergeGradleTasks(
  info: GradleInfo,
  reported: GradleTask[],
): GradleInfo {
  const projects = new Map<string, GradleProject>(
    info.projects.map((project) => [
      project.path,
      { ...project, tasks: project.tasks.map((task) => ({ ...task })) },
    ]),
  );

  for (const task of reported) {
    const cut = task.path.lastIndexOf(":");
    const projectPath =
      cut <= 0 ? ":" : `:${task.path.slice(0, cut).replace(/^:/, "")}`;
    let project = projects.get(projectPath);

    if (!project) {
      project = {
        path: projectPath,
        name: projectPath.split(":").pop() || projectPath,
        dir: projectPath.slice(1).replace(/:/g, "/"),
        buildFile: null,
        plugins: [],
        tasks: [],
      };
      projects.set(projectPath, project);
    }

    const existing = project.tasks.find((known) => known.name === task.name);

    if (existing) {
      if (task.kind !== "other") {
        existing.kind = task.kind;
      }
      if (task.description) {
        existing.description = task.description;
      }
    } else {
      project.tasks.push(task);
    }
  }

  return { ...info, projects: [...projects.values()] };
}

function speedHint(id: string): number {
  return /flash|bolt|lightning|nano|mini|small|fast/i.test(id) ? 0 : 1;
}

/** Fastest tested model, on any provider, other than the one that just stalled. */
function fallbackModel(settings: AssistantSettings): ModelRef | null {
  const candidates = modelOptions(settings).filter(
    (option) => !sameModel(option, settings.chat),
  );

  const ranked = [...candidates].sort(
    (left, right) =>
      (left.latency ?? Number.MAX_SAFE_INTEGER) -
        (right.latency ?? Number.MAX_SAFE_INTEGER) ||
      speedHint(left.model) - speedHint(right.model) ||
      left.model.localeCompare(right.model),
  );

  const best = ranked[0];
  return best ? { provider: best.provider, model: best.model } : null;
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
  const [gitTags, setGitTags] = useState<GitTag[]>([]);
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
  // The Gradle panel shares the right-hand slot with the assistant.
  // Gradle and the website preview share the right-hand slot with the
  // assistant; at most one of the three is open.
  const [sidePanel, setSidePanel] = useState<"gradle" | "preview" | null>(
    null,
  );
  const gradleOpen = sidePanel === "gradle" && !assistantOpen;
  const previewPanelOpen = sidePanel === "preview" && !assistantOpen;
  const [gradle, setGradle] = useState<GradleInfo | null>(null);
  const [gradleBusy, setGradleBusy] = useState(false);
  const [gradleQuerying, setGradleQuerying] = useState(false);
  const [gradleQueried, setGradleQueried] = useState(false);
  const [gradleError, setGradleError] = useState<string | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  // The JDK that runs Gradle, chosen per project folder on this machine.
  const [gradleJvm, setGradleJvm] = useState("");
  // The next line for the terminal to type, e.g. a Gradle task to run.
  const [terminalCommand, setTerminalCommand] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [assistantFull, setAssistantFull] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<
    AssistantMessage[]
  >([]);
  const [assistantPending, setAssistantPending] = useState(false);
  // A prompt from a right-click action; the assistant composer takes it once.
  const [assistantSeed, setAssistantSeed] = useState<string | null>(null);
  // The running turn as a timeline. The ref is the source of truth so the
  // finished message can be built from it the moment the run resolves.
  const [live, setLive] = useState<{ blocks: MessageBlock[] } | null>(null);
  const liveBlocks = useRef<MessageBlock[] | null>(null);
  const updateLive = useCallback(
    (update: (blocks: MessageBlock[]) => MessageBlock[]) => {
      if (!liveBlocks.current) {
        return;
      }

      liveBlocks.current = update(liveBlocks.current);
      setLive({ blocks: liveBlocks.current });
    },
    [],
  );
  const startLive = useCallback((blocks: MessageBlock[] = []) => {
    liveBlocks.current = blocks;
    setLive({ blocks });
  }, []);
  // Older turns summarised so the conversation stays inside the model's
  // context window; the messages it covers stay on screen.
  const [condensed, setCondensed] = useState<CondensedHistory | null>(null);
  const [condensing, setCondensing] = useState(false);
  // Proposed file changes waiting on Accept/Reject, keyed by step id.
  const [approvals, setApprovals] = useState<Record<number, ApprovalRequest>>(
    {},
  );
  const [autoApprove, setAutoApprove] = useState(
    () => localStorage.getItem(AUTO_APPROVE_KEY) === "true",
  );
  const [view, setView] = useState<"editor" | "settings">("editor");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const [themeId, setThemeId] = useState<string>(loadThemeId);
  const [settings, setSettings] = useState<AssistantSettings>(
    loadAssistantSettings,
  );
  // Keys live in the OS credential store, which can only be read
  // asynchronously, so they join the settings once they arrive.
  useEffect(() => {
    let cancelled = false;

    void loadStoredKeys(loadAssistantSettings()).then((keys) => {
      if (!cancelled) {
        setSettings((current) => ({ ...current, keys }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);
  // Updates download in the background and install when the window closes.
  const [update, setUpdate] = useState<UpdateState>(updateState);
  useEffect(() => {
    const stopListening = onUpdateState(setUpdate);
    const stopUpdates = startAutoUpdates();

    return () => {
      stopListening();
      stopUpdates();
    };
  }, []);
  const handleCheckUpdates = useCallback(async () => {
    const result = await checkForUpdates();

    if (result.phase === "current") {
      setNotice("Nexium Studio is up to date.");
    } else if (result.phase === "error") {
      setNotice(result.message);
    }
  }, []);
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

      // The shell starts in the project folder, so there is nothing to show
      // until one is open.
      if (!rootPath) {
        setNotice("Open a project to use the terminal.");
        return;
      }

      setView("editor");
      setTerminalUsed(true);
      // Settings hides the panel without closing it, so asking for the
      // terminal there means show it rather than flip its hidden state.
      setTerminalOpen((open) => (view === "settings" ? true : !open));
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [view, rootPath]);

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

  // The model the assistant and its helpers talk to, resolved to a provider
  // endpoint and key; null until a provider and model are set up.
  const chatTarget = targetFor(settings, settings.chat);
  const completionTarget = targetFor(
    settings,
    settings.completion ?? settings.chat,
  );
  const configured = chatTarget !== null;

  // Ghost-text completions start the moment a model is set up and stop when
  // its provider's key is removed.
  const completionKey = completionTarget
    ? `${completionTarget.provider}|${completionTarget.baseUrl}|${completionTarget.model}|${completionTarget.apiKey}`
    : "";
  useEffect(() => {
    setInlineCompletionModel(completionTarget);
  }, [completionKey]);


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
    // Tags are listed beside the changes; a repository without any is fine.
    void readGitTags()
      .then(setGitTags)
      .catch(() => setGitTags([]));
  }, [applyGit, tree]);

  /**
   * Runs a tag operation and keeps the list and the panel's error line
   * current. Resolves to the error message, or null when it worked.
   */
  const applyTags = useCallback(
    async (
      action: () => Promise<GitTag[]>,
      success: string,
    ): Promise<string | null> => {
      setGitBusy(true);

      try {
        setGitTags(await action());
        setGitError(null);
        setNotice(success);
        return null;
      } catch (cause) {
        const message = toError(cause, "The tag operation failed.").message;
        setGitError(message);
        // A tag can be created even when its push fails.
        void readGitTags().then(setGitTags).catch(() => {});
        return message;
      } finally {
        setGitBusy(false);
      }
    },
    [],
  );

  const handleCreateTag = useCallback(
    (name: string, message: string, push: boolean) =>
      applyTags(
        () => createGitTag(name, message, push),
        push ? `Created and pushed ${name}.` : `Created ${name}.`,
      ),
    [applyTags],
  );

  const handlePushTag = useCallback(
    async (name: string) =>
      (await applyTags(() => pushGitTag(name), `Pushed ${name} to origin.`)) ===
      null,
    [applyTags],
  );

  const handleDeleteTag = useCallback(
    async (name: string) =>
      (await applyTags(
        () => deleteGitTag(name),
        `Deleted the local tag ${name}.`,
      )) === null,
    [applyTags],
  );

  const refreshGitRef = useRef(refreshGit);
  refreshGitRef.current = refreshGit;

  const hasTree = tree !== null;

  /** Re-reads the build scripts; a full Gradle listing has to be redone. */
  const refreshGradle = useCallback(async () => {
    if (!hasTree || (isTauri() && !rootPath)) {
      setGradle(null);
      return;
    }

    setGradleBusy(true);

    try {
      setGradle(await detectGradle());
      setGradleQueried(false);
      setGradleError(null);
    } catch (cause) {
      setGradle(null);
      setGradleError(
        toError(cause, "The Gradle build could not be read.").message,
      );
    } finally {
      setGradleBusy(false);
    }
  }, [hasTree, rootPath]);

  const refreshGradleRef = useRef(refreshGradle);
  refreshGradleRef.current = refreshGradle;

  // Every opened folder gets a fresh look at its build.
  useEffect(() => {
    void refreshGradle();
  }, [refreshGradle, workspaceKey]);

  useEffect(() => {
    setGradleJvm(rootPath ? loadGradleJvm(rootPath) : "");
  }, [rootPath]);

  // A folder that is not a Gradle build has nothing to show in the panel.
  useEffect(() => {
    if (!gradle?.detected) {
      setSidePanel((current) => (current === "gradle" ? null : current));
    }
  }, [gradle]);

  // Opening the assistant hands it the right-hand slot.
  useEffect(() => {
    if (assistantOpen) {
      setSidePanel(null);
    }
  }, [assistantOpen]);

  const web = useWebPreview(
    tree !== null && (!isTauri() || rootPath !== ""),
    workspaceKey,
  );
  const refreshWebRef = useRef(web.refresh);
  refreshWebRef.current = web.refresh;

  // New, renamed or deleted pages and package.json files change what can be
  // previewed; the listing is cheap, so any change to the tree re-checks it.
  useEffect(() => {
    if (tree) {
      void refreshWebRef.current();
    }
  }, [tree]);

  useEffect(() => {
    if (web.info && !web.info.detected) {
      setSidePanel((current) => (current === "preview" ? null : current));
    }
  }, [web.info]);

  const toggleSidePanel = useCallback(
    (panel: "gradle" | "preview") => {
      if (sidePanel === panel && !assistantOpen) {
        setSidePanel(null);
        return;
      }

      setAssistantOpen(false);
      setSidePanel(panel);
    },
    [sidePanel, assistantOpen],
  );

  const handleInstallWeb = useCallback((app: WebApp) => {
    setTerminalCommand({
      id: nextCommandId.current++,
      text: installCommand(app, navigator.userAgent.includes("Windows")),
    });
    setView("editor");
    setTerminalUsed(true);
    setTerminalOpen(true);
  }, []);

  const handleQueryGradle = useCallback(async () => {
    setGradleQuerying(true);

    try {
      const reported = await queryGradleTasks(gradleJvm);
      setGradle((current) =>
        current ? mergeGradleTasks(current, reported) : current,
      );
      setGradleQueried(true);
      setGradleError(null);
    } catch (cause) {
      setGradleError(
        toError(cause, "Gradle could not list the tasks.").message,
      );
    } finally {
      setGradleQuerying(false);
    }
  }, [gradleJvm]);

  const nextCommandId = useRef(1);
  const handleRunGradleTask = useCallback(
    (task: GradleTask) => {
      if (!gradle) {
        return;
      }

      if (!isTauri()) {
        setNotice("Running Gradle tasks needs the desktop app.");
        return;
      }

      // The terminal starts on first use and types the line once it is up.
      setTerminalCommand({
        id: nextCommandId.current++,
        text: gradleCommand(gradle, task, gradleJvm),
      });
      setView("editor");
      setTerminalUsed(true);
      setTerminalOpen(true);
      setNotice(`Running ${task.path} in the terminal.`);
    },
    [gradle, gradleJvm],
  );

  const handleCommandSent = useCallback((id: number) => {
    setTerminalCommand((current) => (current?.id === id ? null : current));
  }, []);

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
    () => generateCommitMessage(chatTarget, git?.changes ?? []),
    [git, chatTarget],
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

      if (isGradleScript(activePath)) {
        void refreshGradleRef.current();
      }

      if (affectsWebDetection(activePath)) {
        void refreshWebRef.current();
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
    (ref: ModelRef) => {
      if (sameModel(ref, settings.chat)) {
        return;
      }

      handleSaveSettings({ ...settings, chat: ref });
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

  // How much of the open file goes along with each request.
  const openFileContextChars =
    contextPath && activeContent !== undefined
      ? Math.min(activeContent.length, MAX_CONTEXT_CHARS) + contextPath.length + 120
      : 0;

  /**
   * Summarises everything but the latest exchanges. If the summary request
   * fails, the oldest messages are dropped instead so the next request still
   * fits; either way the messages stay visible in the chat.
   */
  const condenseHistory = useCallback(
    async (
      messages: AssistantMessage[],
      current: CondensedHistory | null,
      window: number,
    ): Promise<{ condensed: CondensedHistory | null; note: string }> => {
      const keep = messagesToKeep(
        (candidate) =>
          contextUsage({
            window,
            messages,
            condensed: candidate,
            openFileChars: openFileContextChars,
          }),
        messages,
        current,
      );
      const older = messagesToCondense(messages, current, keep);

      if (older.length === 0 || !chatTarget) {
        return { condensed: current, note: "Nothing old enough to condense yet." };
      }

      const throughId = older[older.length - 1].id;
      const before =
        older.reduce(
          (total, message) =>
            total +
            estimateTokens(
              message.role === "assistant" ? historyContent(message) : message.text,
            ),
          0,
        ) + (current ? estimateTokens(current.summary) : 0);

      setCondensing(true);

      try {
        const request = condenseRequest(older, current, window);
        // A summary needs no deliberation, so it asks for the fast,
        // no-reasoning reply first; a thinking model otherwise spends minutes
        // on it. A provider that cannot answer that way gets a normal request.
        const summary = (
          await chat(chatTarget, request, 1500, true).catch(() =>
            chat(chatTarget, request, 1500),
          )
        ).trim();
        const saved = Math.max(0, before - estimateTokens(summary));

        return {
          condensed: { summary, throughId, saved: (current?.saved ?? 0) + saved },
          note: `Condensed ${older.length} earlier messages, freeing about ${formatTokens(saved)} tokens`,
        };
      } catch (cause) {
        const summary = [
          current?.summary,
          "Some earlier messages were removed to stay within the model's context window (they could not be summarised).",
        ]
          .filter(Boolean)
          .join("\n\n");

        return {
          condensed: { summary, throughId, saved: (current?.saved ?? 0) + before },
          note: `Could not summarise (${toError(cause, "the request failed").message}); dropped ${older.length} earlier messages instead`,
        };
      } finally {
        setCondensing(false);
      }
    },
    [chatTarget, openFileContextChars],
  );

  const handleCondenseNow = useCallback(async () => {
    const window = contextWindowFor(settings, settings.chat).tokens;
    const result = await condenseHistory(assistantMessages, condensed, window);
    setCondensed(result.condensed);
    setNotice(result.note);
  }, [assistantMessages, condenseHistory, condensed, settings]);

  const assistantContext = useMemo(() => {
    const window = contextWindowFor(settings, settings.chat);

    return {
      ...contextUsage({
        window: window.tokens,
        messages: assistantMessages,
        condensed,
        openFileChars: openFileContextChars,
      }),
      source: window.source,
      threshold: CONDENSE_AT,
    };
  }, [assistantMessages, condensed, openFileContextChars, settings]);

  // A long reply can leave the chat over the threshold; condense straight away
  // rather than waiting for the next send, so the meter never sits near 100%.
  // At most one attempt per new message.
  const autoCondensed = useRef("");
  useEffect(() => {
    if (
      assistantPending ||
      condensing ||
      !chatTarget ||
      assistantContext.ratio < CONDENSE_AT ||
      messagesToCondense(assistantMessages, condensed, 2).length === 0
    ) {
      return;
    }

    const attempt = `${assistantMessages.length}:${condensed?.throughId ?? -1}`;

    if (autoCondensed.current === attempt) {
      return;
    }

    autoCondensed.current = attempt;
    void handleCondenseNow();
  }, [
    assistantContext.ratio,
    assistantMessages,
    assistantPending,
    chatTarget,
    condensed,
    condensing,
    handleCondenseNow,
  ]);

  const handleSendPrompt = useCallback(
    async (text: string, earlier: AssistantMessage[] = assistantMessages) => {
      const userId = nextMessageId.current;
      nextMessageId.current += 1;

      setAssistantMessages([...earlier, { id: userId, role: "user", text }]);

      if (!chatTarget) {
        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            error: true,
            text: "Choose a provider and model in Settings → AI providers first.",
          },
        ]);
        return;
      }

      // The open file rides along as context; Rust folds it into its own
      // system prompt so the model only ever sees one.
      const system: ChatMessage[] =
        contextPath && activeContent !== undefined
          ? [
              {
                role: "system",
                content: `The user has \`${contextPath}\` open in the editor. Help with this file when relevant.\n\nFile: ${contextPath}\n\`\`\`\n${activeContent.slice(0, MAX_CONTEXT_CHARS)}\n\`\`\``,
              },
            ]
          : [];

      // A retry can cut the conversation above the condensed point; the old
      // summary would then describe messages that are gone.
      let active =
        condensed && earlier.some((message) => message.id === condensed.throughId)
          ? condensed
          : null;
      const window = contextWindowFor(settings, settings.chat).tokens;
      const projected = contextUsage({
        window,
        messages: earlier,
        condensed: active,
        openFileChars: openFileContextChars,
        draft: text,
      });
      let condenseNote: AgentStep | null = null;

      // Condense before the request would pass the threshold, so the model
      // never runs out of room.
      if (
        projected.ratio >= CONDENSE_AT &&
        messagesToCondense(earlier, active, 2).length > 0
      ) {
        setAssistantPending(true);
        condenseNote = {
          id: -1,
          kind: "notice",
          title: "Condensing earlier messages to free up context…",
          status: "running",
        };
        startLive([{ type: "step", step: condenseNote }]);
        const result = await condenseHistory(earlier, active, window);
        active = result.condensed;
        setCondensed(active);
        condenseNote = { ...condenseNote, title: result.note, status: "done" };
        updateLive((blocks) => upsertStep(blocks, condenseNote as AgentStep));
      } else if (active !== condensed) {
        setCondensed(active);
      }

      const history: ChatMessage[] = [
        ...system,
        ...(active
          ? [{ role: "system" as const, content: summaryMessage(active) }]
          : []),
        ...liveMessages(earlier, active)
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content:
              message.role === "assistant"
                ? historyContent(message)
                : message.text,
          })),
        { role: "user", content: text },
      ];

      const finish = (
        reply: Awaited<ReturnType<typeof runAgent>>,
        prefix: MessageBlock[] = [],
      ) => {
        const blocks = finishBlocks(liveBlocks.current ?? prefix, reply);

        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            text: reply.text,
            blocks,
            outOfSteps: reply.out_of_steps === true,
          },
        ]);
      };

      // A stopped or failed run keeps what it already did on screen.
      const fail = (message: string, stopped: boolean) => {
        const blocks = (liveBlocks.current ?? []).filter(
          (block) => block.type === "step",
        );

        setAssistantMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            error: !stopped,
            text: message,
            blocks: blocks.length > 0 && stopped ? blocks : undefined,
          },
        ]);
      };

      setAssistantPending(true);

      if (!condenseNote) {
        startLive();
      }

      try {
        finish(
          await runAgent(chatTarget, history, autoApprove),
        );
      } catch (cause) {
        const failure = toError(cause, "The request failed.");
        const stopped = failure.message === "Stopped.";
        const fallback = stopped ? null : fallbackModel(settings);
        const alternative = targetFor(settings, fallback);

        // A silent, very large model would otherwise dead-end the request.
        if (alternative && stalled(failure.message)) {
          const note: AgentStep = {
            id: 0,
            kind: "notice",
            title: `${chatTarget.model} stopped responding — retried with ${alternative.model} (${alternative.name})`,
            status: "done",
          };

          startLive([{ type: "step", step: note }]);

          try {
            finish(
              await runAgent(alternative, history, autoApprove),
            );
          } catch (retryCause) {
            const retryFailure = toError(retryCause, "The request failed.");
            fail(retryFailure.message, retryFailure.message === "Stopped.");
          }
        } else {
          fail(failure.message, stopped);
        }
      } finally {
        liveBlocks.current = null;
        setAssistantPending(false);
        setLive(null);
        setApprovals({});
      }
    },
    [
      activeContent,
      assistantMessages,
      autoApprove,
      chatTarget,
      condenseHistory,
      condensed,
      contextPath,
      openFileContextChars,
      settings,
      startLive,
      updateLive,
    ],
  );

  const handleDecide = useCallback((stepId: number, accept: boolean) => {
    setApprovals((current) => {
      const next = { ...current };
      delete next[stepId];
      return next;
    });
    void decideChange(stepId, accept).catch((cause) => {
      setNotice(toError(cause, "The decision could not be sent.").message);
    });
  }, []);

  const handleRetry = useCallback(
    (messageId: number) => {
      const index = assistantMessages.findIndex(
        (message) => message.id === messageId,
      );
      let userIndex = index - 1;

      while (userIndex >= 0 && assistantMessages[userIndex].role !== "user") {
        userIndex -= 1;
      }

      if (userIndex < 0) {
        return;
      }

      void handleSendPrompt(
        assistantMessages[userIndex].text,
        assistantMessages.slice(0, userIndex),
      );
    },
    [assistantMessages, handleSendPrompt],
  );

  const handleContinue = useCallback(() => {
    void handleSendPrompt(
      "Continue where you left off and finish the task.",
    );
  }, [handleSendPrompt]);

  const handleNewChat = useCallback(() => {
    setAssistantMessages([]);
    setApprovals({});
    setCondensed(null);
  }, []);

  const toggleAutoApprove = useCallback(() => {
    setAutoApprove((current) => {
      const next = !current;
      localStorage.setItem(AUTO_APPROVE_KEY, String(next));
      return next;
    });
  }, []);

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
      updateLive((blocks) => upsertStep(blocks, step));
    });

    attach<AgentDelta>("agent-delta", (delta) => {
      updateLive((blocks) => appendDelta(blocks, delta));
    });

    attach<ApprovalRequest>("agent-approval", (request) => {
      setApprovals((current) => ({ ...current, [request.stepId]: request }));
    });

    return () => {
      active = false;

      for (const stop of stops) {
        stop();
      }
    };
  }, [updateLive]);

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

      if (isGradleScript(path)) {
        void refreshGradleRef.current();
      }

      if (affectsWebDetection(path)) {
        void refreshWebRef.current();
      }

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

  // What the assistant panel needs beyond the conversation itself; shared by
  // the side panel and the full-screen layout.
  const assistantExtras = {
    approvals,
    onDecide: handleDecide,
    onOpenChange: (request: ApprovalRequest) => {
      setAssistantFull(false);
      setView("editor");
      setDiff({
        path: request.path,
        staged: false,
        original: request.before,
        modified: request.after,
      });
    },
    onOpenFile: (path: string) => {
      setAssistantFull(false);
      setView("editor");
      void handleSelect(path);
    },
    onInsertCode:
      activeContent !== undefined && !diff
        ? (code: string) => editorRef.current?.insertText(code)
        : null,
    onNewChat: handleNewChat,
    context: assistantContext,
    condensed,
    condensing,
    canCondense:
      !assistantPending &&
      !condensing &&
      messagesToCondense(assistantMessages, condensed, 2).length > 0,
    onCondense: () => void handleCondenseNow(),
    onRetry: handleRetry,
    onContinue: handleContinue,
    autoApprove,
    onToggleAutoApprove: toggleAutoApprove,
  };
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
            projectSettingsDisabled={!tree}
            onProjectSettings={() => setProjectSettingsOpen(true)}
            onAbout={() => setAboutOpen(true)}
            onCheckUpdates={() => void handleCheckUpdates()}
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
            {...assistantExtras}
              messages={assistantMessages}
              configured={configured}
              model={settings.chat}
              pending={assistantPending}
              live={live}
              contextPath={contextPath}
              models={modelOptions(settings)}
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
            canGenerate={configured}
            onSelect={(path, staged) => void handleOpenDiff(path, staged)}
            onHide={() => setScmOpen(false)}
            tags={gitTags}
            onCreateTag={handleCreateTag}
            onPushTag={handlePushTag}
            onDeleteTag={handleDeleteTag}
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
              <ProvidersSettings
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

          {/* Keyed by the workspace: opening another project unmounts the
              panel, which kills the old shell and starts one in the new folder. */}
          {terminalUsed && rootPath && (
            <TerminalPanel
              key={workspaceKey}
              active={terminalOpen && view !== "settings"}
              themeId={themeId}
              command={terminalCommand}
              onCommandSent={handleCommandSent}
              onHide={() => setTerminalOpen(false)}
            />
          )}
        </div>

        {assistantOpen && view !== "settings" && (
          <AiAssistant
            {...assistantExtras}
            messages={assistantMessages}
            configured={configured}
            model={settings.chat}
            pending={assistantPending}
            live={live}
            contextPath={contextPath}
            models={modelOptions(settings)}
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

        {gradleOpen && view !== "settings" && (
          <GradlePanel
            info={gradle}
            busy={gradleBusy}
            querying={gradleQuerying}
            queried={gradleQueried}
            error={gradleError}
            onRefresh={() => void refreshGradle()}
            onQueryAll={() => void handleQueryGradle()}
            onRun={handleRunGradleTask}
            onOpenFile={(path) => void handleSelect(path)}
            onHide={() => setSidePanel(null)}
          />
        )}

        {previewPanelOpen && view !== "settings" && (
          <WebPreviewPanel
            preview={web}
            activePath={activePath}
            onInstall={handleInstallWeb}
            onHide={() => setSidePanel(null)}
          />
        )}

        {view !== "settings" && (
          <AssistantRail
            assistantOpen={assistantOpen}
            onToggleAssistant={() => setAssistantOpen((open) => !open)}
            gradleAvailable={Boolean(gradle?.detected)}
            gradleOpen={gradleOpen}
            gradleRunnable={
              gradle?.projects.reduce(
                (count, project) =>
                  count +
                  project.tasks.filter((task) => task.kind === "run").length,
                0,
              ) ?? 0
            }
            onToggleGradle={() => toggleSidePanel("gradle")}
            previewAvailable={Boolean(web.info?.detected)}
            previewOpen={previewPanelOpen}
            previewRunning={web.dev !== null || web.live !== null}
            onTogglePreview={() => toggleSidePanel("preview")}
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

        {update.phase === "downloading" && (
          <span
            title={`Downloading Nexium Studio ${update.version}`}
            className="flex items-center gap-1.5 border-r border-line px-2.5 text-ink/45"
          >
            <Download className="size-3 shrink-0 text-ink/35" strokeWidth={1.75} />
            Update {update.version}
            {update.total
              ? ` · ${Math.min(100, Math.round((update.received / update.total) * 100))}%`
              : "…"}
          </span>
        )}
        {update.phase === "ready" && (
          <span className="flex items-center border-r border-line text-ink/60">
            <span
              title={update.notes || `Nexium Studio ${update.version} is downloaded and installs when you close the app.`}
              className="flex items-center gap-1.5 px-2.5"
            >
              <Download className="size-3 shrink-0 text-ink/50" strokeWidth={1.75} />
              {update.version} installs on close
            </span>
            <button
              type="button"
              onClick={() => void installNow()}
              title="Install the update and restart now"
              className="h-full px-2 text-ink/70 transition-colors duration-150 hover:bg-ink/[0.08] hover:text-ink"
            >
              Restart now
            </button>
          </span>
        )}
        {update.phase === "installing" && (
          <span className="flex items-center gap-1.5 border-r border-line px-2.5 text-ink/60">
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
            Installing {update.version}…
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
            {settings.chat?.model || "no model"}
          </span>
        </button>
      </footer>
      )}

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}

      {projectSettingsOpen && tree && (
        <ProjectSettingsDialog
          projectName={tree.name}
          gradleDetected={Boolean(gradle?.detected)}
          gradleJvm={gradleJvm}
          onSaved={(changed, jvm) => {
            saveGradleJvm(rootPath, jvm);
            setGradleJvm(jvm);
            void refreshGradle();
            setNotice(
              changed.length > 0
                ? `Project settings saved to ${changed.join(", ")}.`
                : "Gradle JDK saved for this machine.",
            );
          }}
          onClose={() => setProjectSettingsOpen(false)}
        />
      )}

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
