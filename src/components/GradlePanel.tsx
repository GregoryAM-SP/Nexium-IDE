import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FlaskConical,
  Hammer,
  ListTree,
  LoaderCircle,
  PanelRightClose,
  Play,
  RotateCw,
  Search,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  GradleInfo,
  GradleProject,
  GradleTask,
  GradleTaskKind,
} from "../lib/gradle";

type GradlePanelProps = {
  info: GradleInfo | null;
  busy: boolean;
  /** True while Gradle itself is listing every task. */
  querying: boolean;
  /** Set once the full list from Gradle has been merged in. */
  queried: boolean;
  error: string | null;
  onRefresh: () => void;
  onQueryAll: () => void;
  onRun: (task: GradleTask) => void;
  onOpenFile: (path: string) => void;
  onHide: () => void;
};

const iconButton =
  "flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:text-ink/15";

const KIND_ORDER: GradleTaskKind[] = ["run", "test", "build", "custom", "other"];

const KIND_LABEL: Record<GradleTaskKind, string> = {
  run: "Run",
  test: "Verification",
  build: "Build",
  custom: "Custom",
  other: "Other",
};

const KIND_ICON: Record<GradleTaskKind, LucideIcon> = {
  run: Play,
  test: FlaskConical,
  build: Hammer,
  custom: Wrench,
  other: Wrench,
};

function matches(task: GradleTask, query: string): boolean {
  if (!query) {
    return true;
  }

  const needle = query.toLowerCase();

  return (
    task.path.toLowerCase().includes(needle) ||
    task.description.toLowerCase().includes(needle)
  );
}

function TaskRow({
  task,
  label,
  onRun,
  prominent = false,
}: {
  task: GradleTask;
  /** Shown instead of the bare name, e.g. the project for a runnable task. */
  label?: string;
  onRun: (task: GradleTask) => void;
  prominent?: boolean;
}) {
  const Icon = KIND_ICON[task.kind] ?? Wrench;

  return (
    <button
      type="button"
      onClick={() => onRun(task)}
      title={`Run ${task.path}${task.description ? ` — ${task.description}` : ""}`}
      className={`group flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-ink/[0.05] ${
        prominent ? "py-1.5" : "py-[4px]"
      }`}
    >
      <span
        className={`flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset transition-colors duration-150 ${
          prominent
            ? "size-6 bg-ink/[0.06] text-ink/60 ring-ink/[0.08] group-hover:bg-ink group-hover:text-app"
            : "size-[18px] bg-ink/[0.03] text-ink/35 ring-ink/[0.05] group-hover:text-ink/80"
        }`}
      >
        <Icon
          className={prominent ? "size-3" : "size-2.5"}
          strokeWidth={2}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate font-mono ${
            prominent
              ? "text-[11.5px] text-ink/80"
              : "text-[11px] text-ink/65 group-hover:text-ink/90"
          }`}
        >
          {label ?? task.name}
        </span>
        {prominent && task.description && (
          <span className="block truncate text-[10.5px] text-ink/30">
            {task.description}
          </span>
        )}
      </span>
      <Play
        className="size-3 shrink-0 text-ink/0 transition-colors duration-150 group-hover:text-ink/50"
        strokeWidth={2}
      />
    </button>
  );
}

function ProjectSection({
  project,
  query,
  defaultOpen,
  onRun,
  onOpenFile,
}: {
  project: GradleProject;
  query: string;
  defaultOpen: boolean;
  onRun: (task: GradleTask) => void;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = project.tasks.filter((task) => matches(task, query));
  // A search opens every project so its hits are not hidden in a fold.
  const expanded = open || query.length > 0;

  if (query && visible.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-line last:border-b-0">
      <div className="group flex h-8 items-center gap-1 pr-2 pl-1.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0 text-ink/30" strokeWidth={2} />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-ink/30" strokeWidth={2} />
          )}
          <span className="truncate text-[11.5px] font-medium text-ink/70">
            {project.name}
          </span>
          {project.path !== ":" && (
            <span className="shrink-0 truncate font-mono text-[9.5px] text-ink/25">
              {project.path}
            </span>
          )}
        </button>
        {project.plugins.slice(0, 2).map((plugin) => (
          <span
            key={plugin}
            className="shrink-0 rounded bg-ink/[0.05] px-1.5 text-[9px] leading-4 text-ink/40"
          >
            {plugin}
          </span>
        ))}
        {project.buildFile && (
          <button
            type="button"
            onClick={() => onOpenFile(project.buildFile!)}
            aria-label={`Open ${project.buildFile}`}
            title={`Open ${project.buildFile}`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-ink/25 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-ink/[0.08] hover:text-ink"
          >
            <FileCode className="size-3" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="pb-2 pl-3 pr-1.5">
          {visible.length === 0 ? (
            <p className="px-2 py-1 text-[10.5px] text-ink/25">
              No tasks detected.
            </p>
          ) : (
            KIND_ORDER.map((kind) => {
              const tasks = visible.filter((task) => task.kind === kind);

              if (tasks.length === 0) {
                return null;
              }

              return (
                <div key={kind} className="mt-1 first:mt-0">
                  <p className="px-2 pt-1 pb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-ink/25">
                    {KIND_LABEL[kind]}
                  </p>
                  {tasks.map((task) => (
                    <TaskRow key={task.path} task={task} onRun={onRun} />
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default function GradlePanel({
  info,
  busy,
  querying,
  queried,
  error,
  onRefresh,
  onQueryAll,
  onRun,
  onOpenFile,
  onHide,
}: GradlePanelProps) {
  const [query, setQuery] = useState("");
  const projects = info?.projects ?? [];

  const runnable = useMemo(
    () =>
      projects.flatMap((project) =>
        project.tasks
          .filter((task) => task.kind === "run" && matches(task, query))
          .map((task) => ({ project, task })),
      ),
    [projects, query],
  );

  const totalTasks = projects.reduce(
    (count, project) => count + project.tasks.length,
    0,
  );

  return (
    <aside
      aria-label="Gradle"
      className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent px-3">
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/45">
          <Hammer className="size-3.5 shrink-0 text-ink/45" strokeWidth={1.75} />
          <span className="truncate">Gradle</span>
          {totalTasks > 0 && (
            <span className="shrink-0 rounded bg-ink/[0.07] px-1.5 font-mono text-[9px] leading-4 tracking-normal text-ink/45">
              {totalTasks}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onQueryAll}
            disabled={querying || !info?.detected}
            aria-label="Load every task from Gradle"
            title={
              querying
                ? "Asking Gradle for every task…"
                : "Load every task from Gradle (starts a Gradle daemon)"
            }
            className={iconButton}
          >
            {querying ? (
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <ListTree className="size-3.5" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            aria-label="Re-read the Gradle build"
            title="Re-read the build scripts"
            className={iconButton}
          >
            <RotateCw
              className={`size-3.5 ${busy ? "animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </button>
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide Gradle"
            title="Hide Gradle"
            className={iconButton}
          >
            <PanelRightClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      {!info?.detected ? (
        <div className="px-3 py-4">
          <div className="rounded-xl border border-line bg-ink/[0.015] p-3">
            <p className="text-[11.5px] text-ink/65">No Gradle build</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">
              This folder has no settings.gradle or build.gradle file at its
              root.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10.5px] text-ink/35">
              <span className="truncate text-ink/60">{info.rootName}</span>
              <span aria-hidden className="text-ink/15">·</span>
              <span className="shrink-0">
                {projects.length} project{projects.length === 1 ? "" : "s"}
              </span>
              <span
                title={
                  info.hasWrapper
                    ? "Tasks run through the project's Gradle wrapper"
                    : "No wrapper found; tasks run with the gradle on your PATH"
                }
                className="ml-auto shrink-0 rounded bg-ink/[0.05] px-1.5 font-mono text-[9px] leading-4 text-ink/40"
              >
                {info.launcher}
              </span>
            </div>
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-ink/[0.08] bg-app px-2 focus-within:border-ink/20">
              <Search className="size-3 shrink-0 text-ink/25" strokeWidth={1.75} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter tasks"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-ink/80 outline-none placeholder:text-ink/25"
              />
            </label>
          </div>

          {error && (
            <p className="shrink-0 border-b border-line px-3 py-1.5 text-[10.5px] leading-relaxed text-red-300/80">
              {error}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-line px-1.5 py-2">
              <p className="px-2 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-ink/30">
                Runnable
              </p>
              {runnable.length === 0 ? (
                <p className="px-2 py-1 text-[10.5px] leading-relaxed text-ink/25">
                  {query
                    ? "No runnable task matches."
                    : "No application plugin was found. Build, test and custom tasks are listed below."}
                </p>
              ) : (
                runnable.map(({ project, task }) => (
                  <TaskRow
                    key={task.path}
                    task={task}
                    label={
                      project.path === ":"
                        ? task.name
                        : `${project.name} › ${task.name}`
                    }
                    onRun={onRun}
                    prominent
                  />
                ))
              )}
            </div>

            {projects.map((project, index) => (
              <ProjectSection
                key={project.path}
                project={project}
                query={query}
                // Small builds open fully; large ones start folded.
                defaultOpen={projects.length <= 3 || index === 0}
                onRun={onRun}
                onOpenFile={onOpenFile}
              />
            ))}

            {!queried && !querying && (
              <button
                type="button"
                onClick={onQueryAll}
                className="mx-3 my-3 flex w-[calc(100%-1.5rem)] items-center justify-center gap-1.5 rounded-md border border-dashed border-ink/[0.12] py-1.5 text-[10.5px] text-ink/40 transition-colors duration-150 hover:border-ink/25 hover:text-ink/70"
              >
                <ListTree className="size-3" strokeWidth={1.75} />
                Load every task from Gradle
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
