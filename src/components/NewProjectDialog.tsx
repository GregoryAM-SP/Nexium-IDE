import {
  Check,
  Cpu,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutGrid,
  LoaderCircle,
  type LucideIcon,
  Package,
  RefreshCw,
  Search,
  Server,
  Smartphone,
  Sparkles,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  cancelCreateProject,
  createProject,
  defaultParent,
  fitName,
  generatorCommand,
  loadTemplates,
  nameProblem,
  pickParent,
  rememberParent,
  TOOL_LINKS,
} from "../lib/templates";
import type { ProjectTemplate, TemplateCatalog } from "../lib/templates";

type NewProjectDialogProps = {
  /** The project was created; open it (and, for "Describe it", ask the assistant). */
  onCreated: (folder: string, prompt?: string) => void;
  onClose: () => void;
};

const DESCRIBE = "describe";
const CATEGORIES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "All", label: "All templates", icon: LayoutGrid },
  { id: "Web", label: "Web", icon: Globe },
  { id: "Mobile", label: "Mobile", icon: Smartphone },
  { id: "Backend", label: "Backend", icon: Server },
  { id: "Systems", label: "Desktop & systems", icon: Cpu },
  { id: "Other", label: "Other", icon: Package },
];
const ICONS: Record<string, LucideIcon> = Object.fromEntries(
  CATEGORIES.map((category) => [category.id, category.icon]),
);
const GIT_KEY = "nexium.newProject.git";
/** Lines of generator output kept on screen. */
const LOG_LINES = 400;

type Phase =
  | { kind: "choose" }
  | { kind: "creating"; steps: string[] }
  | { kind: "failed"; steps: string[]; error: string };

/**
 * New Project: pick a built-in starter or a framework's own generator, name
 * it, choose where it goes, and watch it being created.
 */
export default function NewProjectDialog({ onCreated, onClose }: NewProjectDialogProps) {
  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("html");
  const [name, setName] = useState("my-app");
  const [nameEdited, setNameEdited] = useState(false);
  const [parent, setParent] = useState("");
  const [typescript, setTypescript] = useState(true);
  const [install, setInstall] = useState(true);
  const [git, setGit] = useState(() => localStorage.getItem(GIT_KEY) === "true");
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    loadTemplates()
      .then(setCatalog)
      .catch((cause: unknown) =>
        setLoadError(cause instanceof Error ? cause.message : "The templates could not be loaded."),
      );
  }, []);

  useEffect(() => {
    load();
    void defaultParent().then(setParent);
    searchRef.current?.focus();
  }, [load]);

  const busy = phase.kind === "creating";
  const describing = selected === DESCRIBE;
  const template = catalog?.templates.find((item) => item.id === selected) ?? null;
  const rule = describing ? "folder" : template?.nameRule ?? "folder";
  const missing = template?.requires.filter((tool) => !catalog?.tools[tool]) ?? [];
  const problem = nameProblem(name, rule);
  const canCreate =
    !busy &&
    !problem &&
    parent.trim().length > 0 &&
    (describing ? description.trim().length > 0 : Boolean(template) && missing.length === 0);

  // A name the user has not typed follows the template's naming rule.
  useEffect(() => {
    if (!nameEdited) {
      setName(fitName(rule === "snake" ? "my_app" : "my-app", rule));
    }
  }, [rule, nameEdited]);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.templates ?? []).filter(
      (item) =>
        (category === "All" || item.category === category) &&
        (!needle ||
          `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(needle)),
    );
  }, [catalog, category, query]);

  const append = (text: string) => {
    setLog((current) => {
      // A carriage return redraws the line (progress bars).
      const next = [...current];
      const pieces = text.split("\n");
      pieces.forEach((piece, index) => {
        const line = piece.includes("\r") ? piece.slice(piece.lastIndexOf("\r") + 1) : piece;
        if (index === 0 && next.length > 0) {
          next[next.length - 1] = piece.includes("\r") ? line : next[next.length - 1] + line;
        } else {
          next.push(line);
        }
      });
      return next.length > LOG_LINES ? next.slice(next.length - LOG_LINES) : next;
    });
  };

  const create = async () => {
    if (!canCreate) return;

    const steps: string[] = [];
    setLog([]);
    setPhase({ kind: "creating", steps });
    rememberParent(parent);
    localStorage.setItem(GIT_KEY, String(git));

    try {
      const folder = await createProject(
        {
          template: describing ? "blank" : selected,
          parent,
          name: name.trim(),
          typescript,
          install: Boolean(template?.install) && install,
          git,
        },
        (event) => {
          if (event.kind === "step") {
            steps.push(event.text);
            setPhase({ kind: "creating", steps: [...steps] });
          } else {
            append(event.text);
          }
        },
      );
      onCreated(folder, describing ? description.trim() : undefined);
    } catch (cause) {
      setPhase({
        kind: "failed",
        steps: [...steps],
        error: cause instanceof Error ? cause.message : "The project could not be created.",
      });
    }
  };

  const preview =
    !describing && template?.kind === "generator"
      ? generatorCommand(template, name.trim(), typescript, Boolean(template.install) && install)
      : null;

  const folderPreview = parent ? `${parent.replace(/[\\/]+$/, "")}${parent.includes("\\") ? "\\" : "/"}${name.trim()}` : "";

  const card = (item: ProjectTemplate) => {
    const Icon = ICONS[item.category] ?? Package;
    const active = item.id === selected;
    const needs = item.requires.filter((tool) => !catalog?.tools[tool]);
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => setSelected(item.id)}
        aria-pressed={active}
        className={`flex min-h-[92px] flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 ${
          active
            ? "border-ink/30 bg-ink/[0.08]"
            : "border-ink/[0.08] bg-ink/[0.02] hover:border-ink/20 hover:bg-ink/[0.04]"
        } ${needs.length > 0 ? "opacity-60" : ""}`}
      >
        <span className="flex items-center gap-2">
          <Icon className={`size-3.5 shrink-0 ${active ? "text-ink/80" : "text-ink/40"}`} strokeWidth={1.75} />
          <span className={`min-w-0 flex-1 truncate text-[12px] font-medium ${active ? "text-ink/90" : "text-ink/70"}`}>
            {item.name}
          </span>
          {item.kind === "generator" && (
            <span title="Created by the framework's own tool" className="shrink-0">
              <TerminalSquare className="size-3 text-ink/30" strokeWidth={1.75} />
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-[10.5px] leading-relaxed text-ink/40">{item.description}</span>
        {needs.length > 0 && (
          <span className="mt-auto text-[10px] text-ink/45">Needs {needs.join(", ")}</span>
        )}
      </button>
    );
  };

  const checkbox = (checked: boolean, onChange: (value: boolean) => void, label: string, hint?: string) => (
    <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-ink/70">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={busy}
        className="mt-0.5 size-3.5 accent-current"
      />
      <span>
        {label}
        {hint && <span className="block text-[10.5px] text-ink/35">{hint}</span>}
      </span>
    </label>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        className="flex h-[min(640px,100%)] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border border-ink/10 bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex items-center gap-3 border-b border-ink/[0.07] px-5 py-3.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] ring-1 ring-ink/10 ring-inset">
            <FolderPlus className="size-4 text-ink/75" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="new-project-title" className="text-[13.5px] font-semibold text-ink/90">
              New project
            </h2>
            <p className="text-[11px] text-ink/40">Start from a template, a framework's own generator, or a description.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink disabled:opacity-40"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        {phase.kind === "choose" ? (
          <div className="flex min-h-0 flex-1">
            {/* Categories */}
            <nav className="w-[176px] shrink-0 space-y-0.5 border-r border-ink/[0.07] p-2.5">
              <button
                type="button"
                onClick={() => setSelected(DESCRIBE)}
                className={`mb-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] transition-colors duration-150 ${
                  describing ? "bg-ink/[0.09] text-ink/90" : "text-ink/60 hover:bg-ink/[0.05] hover:text-ink/85"
                }`}
              >
                <Sparkles className="size-3.5" strokeWidth={1.75} />
                Describe it
              </button>
              {CATEGORIES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setCategory(id);
                    if (describing) setSelected(catalog?.templates.find((item) => id === "All" || item.category === id)?.id ?? "html");
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] transition-colors duration-150 ${
                    !describing && category === id
                      ? "bg-ink/[0.07] text-ink/85"
                      : "text-ink/50 hover:bg-ink/[0.05] hover:text-ink/80"
                  }`}
                >
                  <Icon className="size-3.5" strokeWidth={1.75} />
                  {label}
                </button>
              ))}
            </nav>

            <div className="flex min-w-0 flex-1 flex-col">
              {describing ? (
                <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
                  <p className="text-[12px] font-medium text-ink/80">Describe the project</p>
                  <p className="text-[11px] leading-relaxed text-ink/45">
                    Nexium creates an empty folder, opens it, and puts your description in the assistant's message
                    box. Press Enter there and the assistant plans the work as objectives and builds it.
                  </p>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder='For example: "A landing page for Nexium Studio, an IDE, using Bootstrap, with a features section and a download button."'
                    autoFocus
                    className="min-h-0 flex-1 resize-none rounded-xl border border-ink/[0.08] bg-ink/[0.03] p-3 text-[12px] leading-relaxed text-ink/85 outline-none placeholder:text-ink/25 focus:border-ink/20"
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 border-b border-ink/[0.07] px-4 py-2.5">
                    <Search className="size-3.5 text-ink/30" strokeWidth={1.75} />
                    <input
                      ref={searchRef}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search templates"
                      aria-label="Search templates"
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-ink/85 outline-none placeholder:text-ink/30"
                    />
                    <button
                      type="button"
                      onClick={load}
                      title="Look for newly installed tools"
                      aria-label="Look for newly installed tools"
                      className="flex size-6 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink/80"
                    >
                      <RefreshCw className="size-3" strokeWidth={1.75} />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {loadError ? (
                      <p role="alert" className="p-2 text-[11.5px] text-ink/60">{loadError}</p>
                    ) : !catalog ? (
                      <p className="flex items-center gap-2 p-2 text-[11.5px] text-ink/40">
                        <LoaderCircle className="size-3.5 animate-spin" /> Loading templates…
                      </p>
                    ) : visible.length === 0 ? (
                      <p className="p-2 text-[11.5px] text-ink/40">No template matches “{query}”.</p>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
                        {visible.map(card)}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Details and options */}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
                className="space-y-3 border-t border-ink/[0.07] px-4 py-3"
              >
                <div className="grid grid-cols-[1fr_1.4fr] gap-3">
                  <label className="block">
                    <span className="mb-1 block text-[10.5px] uppercase tracking-[0.14em] text-ink/35">Name</span>
                    <input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameEdited(true);
                      }}
                      spellCheck={false}
                      className="h-8 w-full rounded-lg border border-ink/[0.1] bg-ink/[0.03] px-2.5 font-mono text-[12px] text-ink/85 outline-none focus:border-ink/25"
                    />
                  </label>
                  <div>
                    <span className="mb-1 block text-[10.5px] uppercase tracking-[0.14em] text-ink/35">Location</span>
                    <div className="flex gap-1.5">
                      <input
                        value={parent}
                        onChange={(event) => setParent(event.target.value)}
                        spellCheck={false}
                        aria-label="Location"
                        className="h-8 min-w-0 flex-1 rounded-lg border border-ink/[0.1] bg-ink/[0.03] px-2.5 font-mono text-[11.5px] text-ink/75 outline-none focus:border-ink/25"
                      />
                      <button
                        type="button"
                        onClick={() => void pickParent(parent).then((picked) => picked && setParent(picked))}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-ink/[0.12] px-2.5 text-[11px] text-ink/65 transition-colors duration-150 hover:border-ink/30 hover:text-ink"
                      >
                        <FolderOpen className="size-3.5" strokeWidth={1.75} />
                        Browse
                      </button>
                    </div>
                  </div>
                </div>

                {problem ? (
                  <p className="flex items-center gap-2 text-[11px] text-ink/60">
                    {problem}
                    {rule !== "folder" && fitName(name, rule) && fitName(name, rule) !== name && (
                      <button
                        type="button"
                        onClick={() => setName(fitName(name, rule))}
                        className="rounded-md border border-ink/[0.12] px-1.5 py-0.5 font-mono text-[10.5px] text-ink/70 hover:border-ink/30 hover:text-ink"
                      >
                        Use {fitName(name, rule)}
                      </button>
                    )}
                  </p>
                ) : (
                  folderPreview && (
                    <p className="truncate font-mono text-[10.5px] text-ink/35" title={folderPreview}>
                      {folderPreview}
                    </p>
                  )
                )}

                {template && !describing && (
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {template.typescript && checkbox(typescript, setTypescript, "TypeScript")}
                    {template.install &&
                      checkbox(install, setInstall, "Install dependencies", template.kind === "generator" ? "Can take a few minutes" : undefined)}
                    {catalog?.tools.git !== false && checkbox(git, setGit, "Start a git repository")}
                  </div>
                )}
                {describing && catalog?.tools.git !== false && checkbox(git, setGit, "Start a git repository")}

                {template && !describing && missing.length > 0 && (
                  <p className="rounded-lg bg-ink/[0.04] px-3 py-2 text-[11px] leading-relaxed text-ink/60">
                    {template.name} needs {missing.join(" and ")}, which {missing.length > 1 ? "were" : "was"} not found on this computer. Install it
                    {missing.map((tool) => TOOL_LINKS[tool]).filter(Boolean).length > 0 && (
                      <> from <span className="select-text font-mono text-ink/75">{[...new Set(missing.map((tool) => TOOL_LINKS[tool]).filter(Boolean))].join(", ")}</span></>
                    )}
                    , restart Nexium Studio, and it will be available.
                  </p>
                )}

                <div className="flex items-center gap-3">
                  <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink/30" title={preview ?? undefined}>
                    {preview ? `Runs: ${preview}` : !describing && template?.runsWith.length ? `Runs with ${template.runsWith.join(", ")}` : ""}
                  </p>
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-8 rounded-lg px-3 text-[11.5px] text-ink/55 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!canCreate}
                    className="h-8 rounded-lg bg-ink px-4 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/10 disabled:text-ink/30"
                  >
                    {describing ? "Create and describe" : "Create project"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : (
          /* Progress */
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
            <ol className="space-y-1.5">
              {phase.steps.map((step, index) => {
                const last = index === phase.steps.length - 1;
                const running = phase.kind === "creating" && last;
                const failed = phase.kind === "failed" && last;
                return (
                  <li key={`${index}-${step}`} className="flex items-center gap-2 text-[12px] text-ink/75">
                    {running ? (
                      <LoaderCircle className="size-3.5 animate-spin text-ink/50" />
                    ) : failed ? (
                      <X className="size-3.5 text-ink/60" strokeWidth={2} />
                    ) : (
                      <Check className="size-3.5 text-ink/50" strokeWidth={2} />
                    )}
                    {step}
                  </li>
                );
              })}
              {phase.steps.length === 0 && phase.kind === "creating" && (
                <li className="flex items-center gap-2 text-[12px] text-ink/60">
                  <LoaderCircle className="size-3.5 animate-spin" /> Starting…
                </li>
              )}
            </ol>

            {log.length > 0 && (
              <pre
                ref={logRef}
                className="min-h-0 flex-1 overflow-auto rounded-xl border border-ink/[0.07] bg-app/60 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink/60"
              >
                {log.join("\n")}
              </pre>
            )}

            {phase.kind === "failed" && (
              <p role="alert" className="rounded-lg bg-ink/[0.05] px-3 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink/75">
                {phase.error}
              </p>
            )}

            <div className="mt-auto flex justify-end gap-2">
              {phase.kind === "creating" ? (
                <button
                  type="button"
                  onClick={() => void cancelCreateProject()}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-ink/[0.12] px-3 text-[11.5px] text-ink/70 transition-colors duration-150 hover:border-ink/30 hover:text-ink"
                >
                  <Square className="size-3 fill-current" />
                  Stop
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-8 rounded-lg px-3 text-[11.5px] text-ink/55 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhase({ kind: "choose" })}
                    className="h-8 rounded-lg bg-ink px-4 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90"
                  >
                    Back
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
