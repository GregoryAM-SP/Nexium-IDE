import { listen } from "@tauri-apps/api/event";
import {
  ChevronRight,
  ArrowDown,
  ArrowUp,
  CloudUpload,
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
import BranchMenu from "./components/BranchMenu";
import NewProjectDialog from "./components/NewProjectDialog";
import PublishDialog from "./components/PublishDialog";
import RunPanel from "./components/RunPanel";
import { loadRunChoice, loadRunTargets, saveRunChoice } from "./lib/runnable";
import type { RunChoice, Runnable } from "./lib/runnable";
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
  createBranch,
  fetchRemote,
  listBranches,
  pullBranch,
  pushBranch,
  switchBranch,
  checkoutTag,
} from "./lib/git";
import type { GitBranch as Branch, GitStatus, GitTag } from "./lib/git";
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
import { affectsWebDetection, installCommand, sendDevInput } from "./lib/web";
import type { WebApp } from "./lib/web";
import {
  commandIn,
  loadProjectRun,
  runCommand,
  runFor,
  saveProjectRun,
} from "./lib/projectRun";
import type { ProjectRun } from "./lib/projectRun";
import { setInlineCompletionModel } from "./lib/inlineCompletion";
import { languageForPath } from "./lib/languages";
import { isFontPath, isImagePath } from "./lib/media";
import { applyTheme, loadThemeId, saveThemeId } from "./lib/themes";
import { monaco } from "./lib/monacoSetup";
import { cancelAgent, chat, decideChange, runAgent } from "./lib/llm";
import {
  archiveSession,
  createSession,
  deleteSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  titleFrom,
} from "./lib/sessions";
import type { SessionSummary } from "./lib/sessions";
import type {
  AgentDelta,
  AgentStep,
  ApprovalRequest,
  ChatMessage,
  RunActivity,
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
  openWorkspaceAt,
  readFile,
  readWorkspaceSources,
  refreshWorkspace,
  rememberProject,
  reopenLastProject,
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

/** One assistant session's conversation and run, held while the app is open. */
type SessionRuntime = {
  messages: AssistantMessage[];
  condensed: CondensedHistory | null;
  live: { blocks: MessageBlock[]; activity?: RunActivity | null } | null;
  pending: boolean;
  condensing: boolean;
  approvals: Record<number, ApprovalRequest>;
  /** Messages sent while the assistant was busy, in order; each goes out
   * when the reply before it finishes. */
  queue: QueuedPrompt[];
  /** A Stop or an error pauses the queue until the user resumes it. */
  queuePaused: boolean;
};

/** A message waiting its turn. */
export type QueuedPrompt = { id: number; text: string };

const EMPTY_RUNTIME: SessionRuntime = {
  messages: [],
  condensed: null,
  live: null,
  pending: false,
  condensing: false,
  approvals: {},
  queue: [],
  queuePaused: false,
};

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
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [scmOpen, setScmOpen] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  // The status bar's pull/push in progress, and its branch picker.
  const [gitSync, setGitSync] = useState<"pull" | "push" | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
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
  const [sidePanel, setSidePanel] = useState<"gradle" | "preview" | "run" | null>(
    null,
  );
  const gradleOpen = sidePanel === "gradle" && !assistantOpen;
  const previewPanelOpen = sidePanel === "preview" && !assistantOpen;
  const runPanelOpen = sidePanel === "run" && !assistantOpen;
  // Programs the Run panel can start, and whether one is running.
  const [runTargets, setRunTargets] = useState<Runnable[]>([]);
  const [runChoice, setRunChoice] = useState<RunChoice | null>(null);
  const [programRunning, setProgramRunning] = useState(false);
  const [gradle, setGradle] = useState<GradleInfo | null>(null);
  const [gradleBusy, setGradleBusy] = useState(false);
  const [gradleQuerying, setGradleQuerying] = useState(false);
  const [gradleQueried, setGradleQueried] = useState(false);
  const [gradleError, setGradleError] = useState<string | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  // The JDK that runs Gradle, chosen per project folder on this machine.
  const [gradleJvm, setGradleJvm] = useState("");
  // How each app in the open project runs for the preview (per machine).
  const [projectRun, setProjectRun] = useState<ProjectRun>({});
  // The next line for the terminal to type, e.g. a Gradle task to run.
  const [terminalCommand, setTerminalCommand] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [assistantFull, setAssistantFull] = useState(false);
  // Each assistant session keeps its own conversation and run; several can
  // work at once. The active one is what the panel shows.
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Record<string, SessionRuntime>>({});
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  // What was last saved per session, so only real changes are written.
  const savedRef = useRef<
    Record<string, { messages: AssistantMessage[]; condensed: CondensedHistory | null }>
  >({});
  const patchSession = useCallback(
    (id: string, update: (runtime: SessionRuntime) => Partial<SessionRuntime>) => {
      setRuntimes((current) => {
        const runtime = current[id] ?? EMPTY_RUNTIME;
        return { ...current, [id]: { ...runtime, ...update(runtime) } };
      });
    },
    [],
  );
  const activeRuntime =
    (activeSessionId && runtimes[activeSessionId]) || EMPTY_RUNTIME;
  const assistantMessages = activeRuntime.messages;
  const assistantPending = activeRuntime.pending;
  const live = activeRuntime.live;
  // Older turns summarised so the conversation stays inside the model's
  // context window; the messages it covers stay on screen.
  const condensed = activeRuntime.condensed;
  const condensing = activeRuntime.condensing;
  // Proposed changes and commands waiting on Accept/Reject, keyed by step id.
  const approvals = activeRuntime.approvals;
  const runningSessionIds = useMemo(
    () =>
      Object.entries(runtimes)
        .filter(([, runtime]) => runtime.pending)
        .map(([id]) => id),
    [runtimes],
  );
  // A prompt from a right-click action; the assistant composer takes it once.
  const [assistantSeed, setAssistantSeed] = useState<string | null>(null);
  // Each running turn as a timeline, per session. The ref is the source of
  // truth so the finished message can be built the moment the run resolves.
  const liveBlocks = useRef<Record<string, MessageBlock[]>>({});
  const updateLive = useCallback(
    (id: string, update: (blocks: MessageBlock[]) => MessageBlock[]) => {
      const blocks = liveBlocks.current[id];

      if (!blocks) {
        return;
      }

      const next = update(blocks);
      liveBlocks.current[id] = next;
      patchSession(id, (runtime) => ({ live: { ...runtime.live, blocks: next } }));
    },
    [patchSession],
  );
  // What the run is doing right now, for the live status line.
  const setActivity = useCallback(
    (id: string, next: Omit<RunActivity, "since" | "at"> | null) => {
      if (!liveBlocks.current[id]) {
        return;
      }

      patchSession(id, (runtime) => {
        if (!runtime.live) {
          return {};
        }

        const now = Date.now();
        const previous = runtime.live.activity;
        const samePhase =
          previous &&
          next &&
          previous.phase === next.phase &&
          previous.tool === next.tool;

        return {
          live: {
            ...runtime.live,
            activity: next
              ? { ...next, since: samePhase ? previous.since : now, at: now }
              : null,
          },
        };
      });
    },
    [patchSession],
  );
  const startLive = useCallback(
    (id: string, blocks: MessageBlock[] = []) => {
      liveBlocks.current[id] = blocks;
      patchSession(id, () => ({ live: { blocks } }));
    },
    [patchSession],
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
    rememberProject(snapshot.root);
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

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const newProjectAction = useCallback(async () => {
    // The browser build has no filesystem: it keeps the sample project.
    if (!isTauri()) {
      try {
        const snapshot = await newProject();
        if (snapshot) await applyWorkspace(snapshot);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "Could not create that project.");
      }
      return;
    }

    setNewProjectOpen(true);
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

  // Manifests (Cargo.toml, go.mod, *.csproj…) change what can run; the
  // listing is cheap, so any change to the tree re-checks it.
  useEffect(() => {
    if (!tree) {
      setRunTargets([]);
      return;
    }
    let current = true;
    void loadRunTargets()
      .then((found) => {
        if (current) setRunTargets(found);
      })
      .catch(() => {
        if (current) setRunTargets([]);
      });
    return () => {
      current = false;
    };
  }, [tree]);

  useEffect(() => {
    setRunChoice(rootPath ? loadRunChoice(rootPath) : null);
  }, [rootPath]);

  useEffect(() => {
    if (runTargets.length === 0) {
      setSidePanel((current) => (current === "run" ? null : current));
    }
  }, [runTargets]);

  const toggleSidePanel = useCallback(
    (panel: "gradle" | "preview" | "run") => {
      if (sidePanel === panel && !assistantOpen) {
        setSidePanel(null);
        return;
      }

      setAssistantOpen(false);
      setSidePanel(panel);
    },
    [sidePanel, assistantOpen],
  );

  useEffect(() => {
    setProjectRun(loadProjectRun(rootPath));
  }, [rootPath]);

  const commandForApp = useCallback(
    (app: WebApp) => runCommand(app, runFor(projectRun, app)),
    [projectRun],
  );

  /** Types a command for an app (in its folder) into the terminal and runs it. */
  const handleRunAppCommand = useCallback((app: WebApp, command: string) => {
    setTerminalCommand({
      id: nextCommandId.current++,
      text: commandIn(app.dir, command, navigator.userAgent.includes("Windows")),
    });
    setProjectSettingsOpen(false);
    setView("editor");
    setTerminalUsed(true);
    setTerminalOpen(true);
  }, []);

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

  const hotReloadRef = useRef<(path: string) => void>(() => undefined);
  hotReloadRef.current = (path: string) => {
    const running = web.dev;
    if (!path.endsWith(".dart") || !running?.script.startsWith("flutter run")) {
      return;
    }
    const app = web.info?.apps.find((entry) => entry.dir === running.dir);
    const settings = app ? runFor(projectRun, app) : null;
    if (settings?.kind === "flutter" && settings.hotReloadOnSave && settings.mode === "debug") {
      void sendDevInput("r").catch(() => undefined);
    }
  };

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

      // A saved .dart file hot-reloads the Flutter app in the preview.
      hotReloadRef.current(activePath);
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
      sessionId: string,
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

      patchSession(sessionId, () => ({ condensing: true }));

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
        patchSession(sessionId, () => ({ condensing: false }));
      }
    },
    [chatTarget, openFileContextChars, patchSession],
  );

  const handleCondenseNow = useCallback(async () => {
    if (!activeSessionId) {
      return;
    }

    const sessionId = activeSessionId;
    const window = contextWindowFor(settings, settings.chat).tokens;
    const result = await condenseHistory(sessionId, assistantMessages, condensed, window);
    patchSession(sessionId, () => ({ condensed: result.condensed }));
    setNotice(result.note);
  }, [activeSessionId, assistantMessages, condenseHistory, condensed, patchSession, settings]);

  // ── sessions ──────────────────────────────────────────────────────────

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions(showArchived));
    } catch {
      // No database: the list stays as it is.
    }
  }, [showArchived]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const selectSession = useCallback(async (id: string) => {
    setActiveSessionId(id);

    if (runtimesRef.current[id]) {
      return;
    }

    try {
      const data = await loadSession(id);
      const highest = data.messages.reduce((top, message) => Math.max(top, message.id), 0);
      nextMessageId.current = Math.max(nextMessageId.current, highest + 1);
      savedRef.current[id] = { messages: data.messages, condensed: data.condensed };
      setRuntimes((current) =>
        current[id]
          ? current
          : {
              ...current,
              [id]: { ...EMPTY_RUNTIME, messages: data.messages, condensed: data.condensed },
            },
      );
    } catch (cause) {
      setNotice(toError(cause, "The session could not be opened.").message);
    }
  }, []);

  // Opening a folder shows its sessions and reopens the latest one.
  useEffect(() => {
    let cancelled = false;
    setActiveSessionId(null);

    void listSessions(false)
      .then((list) => {
        if (cancelled) {
          return;
        }

        setSessions(list);
        if (list[0]) {
          void selectSession(list[0].id);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [rootPath, selectSession]);

  // A new conversation becomes a saved session with its first message.
  const startSession = useCallback(async (text: string): Promise<string> => {
    const fresh: SessionRuntime = { ...EMPTY_RUNTIME, messages: [] };
    let id: string;

    try {
      const session = await createSession(titleFrom(text));
      id = session.id;
      savedRef.current[id] = { messages: fresh.messages, condensed: null };
      setSessions((current) => [{ ...session, running: false }, ...current]);
    } catch (cause) {
      id = `unsaved-${Date.now()}`;
      setNotice(
        `${toError(cause, "The session database is unavailable.").message} This conversation will not be kept.`,
      );
    }

    setRuntimes((current) => ({ ...current, [id]: fresh }));
    setActiveSessionId(id);
    return id;
  }, []);

  // Every change to a session's messages is written to the database.
  useEffect(() => {
    for (const [id, runtime] of Object.entries(runtimes)) {
      const saved = savedRef.current[id];

      if (!saved || (saved.messages === runtime.messages && saved.condensed === runtime.condensed)) {
        continue;
      }

      savedRef.current[id] = { messages: runtime.messages, condensed: runtime.condensed };
      void saveSession(id, runtime.messages, runtime.condensed)
        .then(() => refreshSessions())
        .catch((cause) => {
          setNotice(toError(cause, "The conversation could not be saved.").message);
        });
    }
  }, [refreshSessions, runtimes]);

  const handleArchiveSession = useCallback(
    async (id: string, archived: boolean) => {
      try {
        await archiveSession(id, archived);
        if (archived && id === activeSessionId) {
          setActiveSessionId(null);
        }
        await refreshSessions();
      } catch (cause) {
        setNotice(toError(cause, "The session could not be archived.").message);
      }
    },
    [activeSessionId, refreshSessions],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        delete savedRef.current[id];
        delete liveBlocks.current[id];
        setRuntimes((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        if (id === activeSessionId) {
          setActiveSessionId(null);
        }
        await refreshSessions();
      } catch (cause) {
        setNotice(toError(cause, "The session could not be deleted.").message);
      }
    },
    [activeSessionId, refreshSessions],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await renameSession(id, title);
        await refreshSessions();
      } catch (cause) {
        setNotice(toError(cause, "The session could not be renamed.").message);
      }
    },
    [refreshSessions],
  );

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
    async (text: string, earlierMessages?: AssistantMessage[], targetSession?: string) => {
      // Everything below belongs to this session, even if the user switches
      // to another one while it runs. A queued message names its session.
      const sessionId = targetSession ?? activeSessionId ?? (await startSession(text));
      const runtime = runtimesRef.current[sessionId];
      const earlier = earlierMessages ?? runtime?.messages ?? [];
      const condensed = runtime?.condensed ?? null;
      const setMessages = (
        update: (messages: AssistantMessage[]) => AssistantMessage[],
      ) => patchSession(sessionId, (runtime) => ({ messages: update(runtime.messages) }));
      const userId = nextMessageId.current;
      nextMessageId.current += 1;

      setMessages(() => [...earlier, { id: userId, role: "user", text }]);

      if (!chatTarget) {
        setMessages((current) => [
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
        patchSession(sessionId, () => ({ pending: true }));
        condenseNote = {
          id: -1,
          kind: "notice",
          title: "Condensing earlier messages to free up context…",
          status: "running",
        };
        startLive(sessionId, [{ type: "step", step: condenseNote }]);
        const result = await condenseHistory(sessionId, earlier, active, window);
        active = result.condensed;
        const settled = active;
        patchSession(sessionId, () => ({ condensed: settled }));
        condenseNote = { ...condenseNote, title: result.note, status: "done" };
        const note = condenseNote;
        updateLive(sessionId, (blocks) => upsertStep(blocks, note));
      } else if (active !== condensed) {
        const settled = active;
        patchSession(sessionId, () => ({ condensed: settled }));
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
        const blocks = finishBlocks(liveBlocks.current[sessionId] ?? prefix, reply);

        setMessages((current) => [
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
        const blocks = (liveBlocks.current[sessionId] ?? []).filter(
          (block) => block.type === "step",
        );

        setMessages((current) => [
          ...current,
          {
            id: nextMessageId.current++,
            role: "assistant",
            error: !stopped,
            text: message,
            blocks: blocks.length > 0 && stopped ? blocks : undefined,
          },
        ]);
        // Whatever is queued waits until the user says to go on.
        patchSession(sessionId, () => ({ queuePaused: true }));
      };

      patchSession(sessionId, () => ({ pending: true }));

      if (!condenseNote) {
        startLive(sessionId);
      }

      try {
        finish(
          await runAgent(chatTarget, history, autoApprove, window, sessionId),
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

          startLive(sessionId, [{ type: "step", step: note }]);

          try {
            finish(
              await runAgent(
                alternative,
                history,
                autoApprove,
                contextWindowFor(settings, fallback).tokens,
                sessionId,
              ),
            );
          } catch (retryCause) {
            const retryFailure = toError(retryCause, "The request failed.");
            fail(retryFailure.message, retryFailure.message === "Stopped.");
          }
        } else {
          fail(failure.message, stopped);
        }
      } finally {
        delete liveBlocks.current[sessionId];
        patchSession(sessionId, () => ({ pending: false, live: null, approvals: {} }));
      }
    },
    [
      activeContent,
      activeSessionId,
      autoApprove,
      chatTarget,
      condenseHistory,
      contextPath,
      openFileContextChars,
      patchSession,
      settings,
      startLive,
      startSession,
      updateLive,
    ],
  );

  /**
   * The composer's send: straight away when the session is free, otherwise
   * onto its queue, to go out when the current reply finishes.
   */
  const handleSubmit = useCallback(
    (text: string) => {
      const id = activeSessionId;
      const runtime = id ? runtimesRef.current[id] : undefined;

      if (id && runtime && (runtime.pending || runtime.condensing)) {
        patchSession(id, (current) => ({
          queue: [...current.queue, { id: nextMessageId.current++, text }],
        }));
        return;
      }

      void handleSendPrompt(text);
    },
    [activeSessionId, handleSendPrompt, patchSession],
  );

  // When a session is free and has something queued (and is not paused),
  // the next message goes out. Every session's queue runs, shown or not.
  const dispatching = useRef(new Set<string>());
  const [queueTick, setQueueTick] = useState(0);
  useEffect(() => {
    for (const [id, runtime] of Object.entries(runtimes)) {
      if (
        runtime.pending ||
        runtime.condensing ||
        runtime.queuePaused ||
        runtime.queue.length === 0 ||
        dispatching.current.has(id)
      ) {
        continue;
      }

      const [next, ...rest] = runtime.queue;
      dispatching.current.add(id);
      patchSession(id, () => ({ queue: rest }));
      void handleSendPrompt(next.text, undefined, id).finally(() => {
        dispatching.current.delete(id);
        // Look again: the run may have ended before this cleared.
        setQueueTick((tick) => tick + 1);
      });
    }
  }, [handleSendPrompt, patchSession, queueTick, runtimes]);

  const handleRemoveQueued = useCallback(
    (queuedId: number) => {
      if (activeSessionId) {
        patchSession(activeSessionId, (runtime) => ({
          queue: runtime.queue.filter((item) => item.id !== queuedId),
        }));
      }
    },
    [activeSessionId, patchSession],
  );

  const handleResumeQueue = useCallback(() => {
    if (activeSessionId) {
      patchSession(activeSessionId, () => ({ queuePaused: false }));
    }
  }, [activeSessionId, patchSession]);

  const handleDecide = useCallback(
    (stepId: number, accept: boolean) => {
      if (!activeSessionId) {
        return;
      }

      const sessionId = activeSessionId;
      patchSession(sessionId, (runtime) => {
        const next = { ...runtime.approvals };
        delete next[stepId];
        return { approvals: next };
      });
      void decideChange(sessionId, stepId, accept).catch((cause) => {
        setNotice(toError(cause, "The decision could not be sent.").message);
      });
    },
    [activeSessionId, patchSession],
  );

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

  // A new session starts empty and is saved with its first message.
  const handleNewChat = useCallback(() => {
    setActiveSessionId(null);
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

    attach<AgentStep & { session?: string }>("agent-step", ({ session, ...step }) => {
      if (session) {
        updateLive(session, (blocks) => upsertStep(blocks, step));
        // The step shows what happens now.
        setActivity(session, null);
      }
    });

    attach<AgentDelta & { session?: string }>("agent-delta", ({ session, ...delta }) => {
      if (session) {
        updateLive(session, (blocks) => appendDelta(blocks, delta));
        setActivity(session, {
          phase: delta.kind === "reasoning" ? "thinking" : "answering",
        });
      }
    });

    attach<Omit<RunActivity, "since" | "at"> & { session?: string }>(
      "agent-activity",
      ({ session, ...activity }) => {
        if (session) {
          setActivity(session, activity);
        }
      },
    );

    attach<ApprovalRequest>("agent-approval", (request) => {
      const session = request.session;
      if (session) {
        patchSession(session, (runtime) => ({
          approvals: { ...runtime.approvals, [request.stepId]: request },
        }));
      }
    });

    return () => {
      active = false;

      for (const stop of stops) {
        stop();
      }
    };
  }, [patchSession, setActivity, updateLive]);

  // The assistant can rewrite a file through its tools; keep the editor in sync.
  const contentsRef = useRef<Record<string, string>>({});
  contentsRef.current = contents;
  const rootRef = useRef("");
  rootRef.current = rootPath;

  // Start where the user left off: the project open when the app last closed,
  // including the restart that installs an update. A folder opened in the
  // meantime wins.
  useEffect(() => {
    let cancelled = false;

    void reopenLastProject()
      .then((snapshot) => {
        if (snapshot && !cancelled && !rootRef.current) {
          return applyWorkspace(snapshot);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setNotice(toError(cause, "Your last project could not be reopened.").message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyWorkspace]);

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

  /**
   * After a pull or a branch switch the files on disk are different: list the
   * folder again and reload every open file that has no unsaved edits (those
   * are left as they are).
   */
  const reloadFromDisk = useCallback(async () => {
    try {
      const snapshot = await refreshWorkspace(rootRef.current);
      setTree(snapshot.tree);
    } catch {
      // The folder may have been closed.
    }

    for (const path of Object.keys(contentsRef.current)) {
      if (dirtyRef.current[path]) {
        continue;
      }

      void readFile(path)
        .then((text) => setContents((current) => ({ ...current, [path]: text })))
        .catch(() => {
          // Not on this branch; the tab keeps what it showed.
        });
    }

    void refreshGradleRef.current();
    void refreshWebRef.current();
  }, []);

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const handlePull = useCallback(async () => {
    setGitSync("pull");
    const before = git?.behind ?? 0;

    try {
      const next = await pullBranch();
      setGit(next);
      setNotice(
        before > 0
          ? `Pulled ${plural(before, "commit")} from ${next.upstream ?? "the remote"}.`
          : `${next.branch} is up to date with ${next.upstream ?? "the remote"}.`,
      );
      await reloadFromDisk();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The pull failed.");
    } finally {
      setGitSync(null);
    }
  }, [git, reloadFromDisk]);

  const handlePush = useCallback(async () => {
    setGitSync("push");
    const before = git?.ahead ?? 0;
    const publishing = !git?.upstream;

    try {
      const next = await pushBranch();
      setGit(next);
      setNotice(
        publishing
          ? `Published ${next.branch} to ${next.upstream ?? "origin"}.`
          : before > 0
            ? `Pushed ${plural(before, "commit")} to ${next.upstream ?? "the remote"}.`
            : `Nothing new to push; ${next.upstream ?? "the remote"} already has ${next.branch}.`,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The push failed.");
    } finally {
      setGitSync(null);
    }
  }, [git]);

  const handleSwitchBranch = useCallback(
    async (branch: Branch): Promise<string | null> => {
      try {
        const next = await switchBranch(branch.name, branch.remote);
        setGit(next);
        setNotice(`Switched to ${next.branch}.`);
        await reloadFromDisk();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Could not switch branch.";
      }
    },
    [reloadFromDisk],
  );

  const handleCheckoutTag = useCallback(
    async (tag: GitTag): Promise<string | null> => {
      try {
        setGit(await checkoutTag(tag.name));
        setNotice(`Checked out ${tag.name}. You are not on a branch; create one from here to commit.`);
        await reloadFromDisk();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Could not check out the tag.";
      }
    },
    [reloadFromDisk],
  );

  const handleCreateBranch = useCallback(async (name: string): Promise<string | null> => {
    try {
      const next = await createBranch(name);
      setGit(next);
      setNotice(`Created ${next.branch} and switched to it.`);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Could not create the branch.";
    }
  }, []);

  // Fetch quietly when a repository with a remote opens, then every five
  // minutes, so the status bar knows how many commits there are to pull.
  const canFetch = Boolean(git?.isRepo && git?.hasRemote);
  useEffect(() => {
    if (!canFetch) {
      return;
    }

    const quietFetch = () =>
      void fetchRemote()
        .then(setGit)
        .catch(() => {
          // Offline or needs credentials: the counts just stay as they were.
        });

    quietFetch();
    const timer = window.setInterval(quietFetch, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [canFetch, rootPath]);

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
    queue: activeRuntime.queue,
    queuePaused: activeRuntime.queuePaused,
    onRemoveQueued: handleRemoveQueued,
    onResumeQueue: handleResumeQueue,
    autoApprove,
    onToggleAutoApprove: toggleAutoApprove,
    sessions,
    activeSessionId,
    runningSessionIds,
    showArchived,
    onToggleArchived: () => setShowArchived((value) => !value),
    onSelectSession: (id: string) => void selectSession(id),
    onArchiveSession: (id: string, archived: boolean) => void handleArchiveSession(id, archived),
    onDeleteSession: (id: string) => void handleDeleteSession(id),
    onRenameSession: (id: string, title: string) => void handleRenameSession(id, title),
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
              onSend={handleSubmit}
              seed={assistantSeed}
              onSeedConsumed={consumeAssistantSeed}
              onStop={() => void cancelAgent(activeSessionId ?? undefined)}
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
            onPublish={() => setPublishOpen(true)}
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
            onSend={handleSubmit}
            seed={assistantSeed}
            onSeedConsumed={consumeAssistantSeed}
            onStop={() => void cancelAgent(activeSessionId ?? undefined)}
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
            commandFor={commandForApp}
            onRunCommand={handleRunAppCommand}
            onOpenSettings={() => setProjectSettingsOpen(true)}
            onHide={() => setSidePanel(null)}
          />
        )}

        {runTargets.length > 0 && (
          <RunPanel
            key={rootPath}
            active={runPanelOpen && view !== "settings"}
            targets={runTargets}
            choice={runChoice}
            onChoice={(next) => {
              setRunChoice(next);
              saveRunChoice(rootPath, next);
            }}
            onRunningChange={setProgramRunning}
            themeId={themeId}
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
            runAvailable={runTargets.length > 0}
            runOpen={runPanelOpen}
            runRunning={programRunning}
            onToggleRun={() => toggleSidePanel("run")}
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

        <span className="relative flex items-stretch border-l border-line first:border-l-0">
          <button
            type="button"
            onClick={() => (git?.isRepo ? setBranchMenuOpen((open) => !open) : setScmOpen(true))}
            aria-expanded={branchMenuOpen}
            title={git?.isRepo ? "Switch or create a branch" : "Source control"}
            className="flex max-w-[16rem] items-center gap-1.5 px-2.5 text-ink/40 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80"
          >
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate">
              {!tree
                ? "no folder"
                : git?.isRepo
                  ? git.branch
                  : "no repository"}
            </span>
          </button>
          {git?.isRepo && git.changes.length > 0 && (
            <button
              type="button"
              onClick={() => setScmOpen(true)}
              title={`${plural(git.changes.length, "change")} — open Source control`}
              className="flex items-center pr-2 transition-colors duration-150 hover:bg-ink/[0.06]"
            >
              <span className="rounded bg-ink/[0.08] px-1 font-mono text-[9px] leading-4 text-ink/50">
                {git.changes.length}
              </span>
            </button>
          )}
          {branchMenuOpen && git?.isRepo && (
            <BranchMenu
              current={git.branch}
              load={listBranches}
              loadTags={readGitTags}
              onSwitch={handleSwitchBranch}
              onCheckoutTag={handleCheckoutTag}
              onCreate={handleCreateBranch}
              onClose={() => setBranchMenuOpen(false)}
            />
          )}
        </span>

        {git?.isRepo && (git.hasRemote === false || git.nestedIn) && (
          <button
            type="button"
            onClick={() => setPublishOpen(true)}
            title="Create a repository on GitHub and push this branch"
            className="flex items-center gap-1.5 border-l border-line px-2.5 text-ink/55 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/85"
          >
            <CloudUpload className="size-3" strokeWidth={1.75} />
            Publish to GitHub
          </button>
        )}

        {newProjectOpen && (
          <NewProjectDialog
            onClose={() => setNewProjectOpen(false)}
            onCreated={(folder, prompt) => {
              void (async () => {
                try {
                  const snapshot = await openWorkspaceAt(folder);
                  await applyWorkspace(snapshot);
                  setNewProjectOpen(false);
                  setNotice(`Created ${snapshot.name}.`);
                  // "Describe it": the description waits in the assistant.
                  if (prompt) askAssistant(prompt);
                } catch (cause) {
                  setNewProjectOpen(false);
                  setNotice(
                    cause instanceof Error
                      ? `The project was created in ${folder}, but it could not be opened: ${cause.message}`
                      : `The project was created in ${folder}, but it could not be opened.`,
                  );
                }
              })();
            }}
          />
        )}

        {publishOpen && (
          <PublishDialog
            isRepo={Boolean(git?.isRepo && !git.nestedIn)}
            nestedIn={git?.nestedIn}
            branch={git?.branch ?? ""}
            onPublished={(result) => {
              setGit(result.status);
              setNotice(
                result.pushed
                  ? `Published to ${result.repo.fullName} on GitHub.`
                  : `Created ${result.repo.fullName} on GitHub.`,
              );
            }}
            onOpenSettings={() => {
              setSettingsSection("source-control");
              openSettings();
            }}
            onClose={() => setPublishOpen(false)}
          />
        )}

        {/* On a tag or a bare commit there is no branch to pull into or push. */}
        {git?.isRepo &&
          git.hasRemote &&
          !git.branch.endsWith(" (detached)") &&
          !git.branch.startsWith("HEAD ") && (
          <span className="flex items-stretch border-l border-line">
            {git.upstream ? (
              <>
                <button
                  type="button"
                  onClick={() => void handlePull()}
                  disabled={gitSync !== null}
                  title={
                    git.behind
                      ? `Pull ${plural(git.behind ?? 0, "commit")} from ${git.upstream}`
                      : `Pull from ${git.upstream} (up to date as of the last fetch)`
                  }
                  aria-label="Pull"
                  className={`flex items-center gap-1 px-2 font-mono text-[10px] transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80 disabled:pointer-events-none ${
                    git.behind ? "text-ink/70" : "text-ink/35"
                  }`}
                >
                  {gitSync === "pull" ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <ArrowDown className="size-3" strokeWidth={1.9} />
                  )}
                  {git.behind ?? 0}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePush()}
                  disabled={gitSync !== null}
                  title={
                    git.ahead
                      ? `Push ${plural(git.ahead ?? 0, "commit")} to ${git.upstream}`
                      : `Push to ${git.upstream} (nothing new to push)`
                  }
                  aria-label="Push"
                  className={`flex items-center gap-1 px-2 font-mono text-[10px] transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/80 disabled:pointer-events-none ${
                    git.ahead ? "text-ink/70" : "text-ink/35"
                  }`}
                >
                  {gitSync === "push" ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <ArrowUp className="size-3" strokeWidth={1.9} />
                  )}
                  {git.ahead ?? 0}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handlePush()}
                disabled={gitSync !== null}
                title={`Push ${git.branch} to origin and track it there`}
                className="flex items-center gap-1.5 px-2.5 text-ink/55 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink/85 disabled:pointer-events-none"
              >
                {gitSync === "push" ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <CloudUpload className="size-3" strokeWidth={1.75} />
                )}
                Publish branch
              </button>
            )}
          </span>
        )}

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
          apps={web.info?.apps ?? []}
          run={projectRun}
          onSaveRun={(next) => {
            saveProjectRun(rootPath, next);
            setProjectRun(next);
            setNotice("Run settings saved. They apply the next time the preview starts.");
          }}
          onRunCommand={handleRunAppCommand}
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
