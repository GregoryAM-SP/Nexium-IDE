import {
  ChevronRight,
  Code2,
  Copy,
  File,
  FileCode2,
  FileJson,
  FilePlus,
  Files,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Image as ImageIcon,
  PanelLeftClose,
  Pencil,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { MouseEvent } from "react";

import type { ExplorerNode, FolderNode } from "../lib/workspace";
import {
  allPaths,
  ancestorPaths,
  joinPath,
  parentPathOf,
} from "../lib/workspaceTree";
import ExplorerContextMenu from "./ExplorerContextMenu";
import type { ContextMenuItem } from "./ExplorerContextMenu";

type Draft =
  | { mode: "create"; parentPath: string; kind: "file" | "folder" }
  | { mode: "rename"; path: string; name: string };

const iconByExtension: Record<string, LucideIcon> = {
  ts: FileCode2,
  tsx: FileCode2,
  js: FileCode2,
  jsx: FileCode2,
  mjs: FileCode2,
  cjs: FileCode2,
  json: FileJson,
  jsonc: FileJson,
  css: Hash,
  scss: Hash,
  less: Hash,
  html: Code2,
  htm: Code2,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  webp: ImageIcon,
  svg: ImageIcon,
  ico: ImageIcon,
  toml: Settings2,
  yml: Settings2,
  yaml: Settings2,
  lock: Settings2,
  env: Settings2,
};

/** A monochrome glyph per file type keeps the tree scannable without colour. */
function fileIcon(name: string): LucideIcon {
  const extension = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";

  return iconByExtension[extension] ?? File;
}

type DraftInputProps = {
  depth: number;
  kind: "file" | "folder";
  initialValue: string;
  validate: (name: string) => boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
};

function DraftInput({
  depth,
  kind,
  initialValue,
  validate,
  onSubmit,
  onCancel,
}: DraftInputProps) {
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  const submitted = useRef(false);

  const name = value.trim();
  const valid = validate(name);

  const submit = () => {
    if (submitted.current) {
      return;
    }

    if (!valid) {
      setTouched(true);
      return;
    }

    submitted.current = true;
    onSubmit(name);
  };

  const Icon = kind === "folder" ? Folder : File;

  return (
    <div
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className="flex items-center gap-1.5 py-[3px] pr-2"
    >
      <Icon
        className="size-3.5 shrink-0 text-ink/25"
        strokeWidth={1.75}
      />
      <input
        autoFocus
        value={value}
        aria-label={kind === "folder" ? "New folder name" : "File name"}
        onChange={(event) => {
          setValue(event.target.value);
          setTouched(true);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            submitted.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          // Clicking away abandons the draft instead of creating it.
          if (!submitted.current) {
            submitted.current = true;
            onCancel();
          }
        }}
        className={`min-w-0 flex-1 rounded-md border bg-ink/[0.06] px-1.5 py-[3px] font-mono text-[11.5px] text-ink outline-none transition-colors duration-150 ${
          !touched || valid
            ? "border-ink/[0.12] focus:border-ink/40"
            : "border-red-400/60 focus:border-red-400"
        }`}
      />
    </div>
  );
}

type TreeContext = {
  activePath: string;
  openPaths: Set<string>;
  draft: Draft | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenMenu: (event: MouseEvent, node: ExplorerNode) => void;
  onSubmitDraft: (name: string) => void;
  onCancelDraft: () => void;
  validateName: (parentPath: string, name: string) => boolean;
};

function TreeNode({
  node,
  depth,
  ctx,
}: {
  node: ExplorerNode;
  depth: number;
  ctx: TreeContext;
}) {
  const indent = { paddingLeft: `${8 + depth * 12}px` };
  const { draft } = ctx;

  if (draft?.mode === "rename" && draft.path === node.path) {
    return (
      <DraftInput
        depth={depth}
        kind={node.kind}
        initialValue={draft.name}
        validate={(name) =>
          name === node.name || ctx.validateName(parentPathOf(node.path), name)
        }
        onSubmit={ctx.onSubmitDraft}
        onCancel={ctx.onCancelDraft}
      />
    );
  }

  if (node.kind === "folder") {
    const open = ctx.openPaths.has(node.path);

    return (
      <div>
        <button
          type="button"
          onClick={() => ctx.onToggle(node.path)}
          onContextMenu={(event) => ctx.onOpenMenu(event, node)}
          style={indent}
          className="flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] text-ink/55 transition-colors duration-100 hover:bg-ink/[0.04] hover:text-ink/90"
        >
          <ChevronRight
            className={`size-3 shrink-0 text-ink/25 transition-transform duration-150 ${
              open ? "rotate-90" : ""
            }`}
            strokeWidth={2}
          />
          {open ? (
            <FolderOpen
              className="size-3.5 shrink-0 text-ink/40"
              strokeWidth={1.75}
            />
          ) : (
            <Folder
              className="size-3.5 shrink-0 text-ink/40"
              strokeWidth={1.75}
            />
          )}
          <span className="truncate">{node.name}</span>
        </button>

        {open && (
          <div>
            {node.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} ctx={ctx} />
            ))}

            {draft?.mode === "create" && draft.parentPath === node.path && (
              <DraftInput
                depth={depth + 1}
                kind={draft.kind}
                initialValue=""
                validate={(name) => ctx.validateName(node.path, name)}
                onSubmit={ctx.onSubmitDraft}
                onCancel={ctx.onCancelDraft}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  const isActive = node.path === ctx.activePath;
  const Icon = fileIcon(node.name);

  return (
    <button
      type="button"
      onClick={() => ctx.onSelect(node.path)}
      onContextMenu={(event) => ctx.onOpenMenu(event, node)}
      style={indent}
      className={`flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-100 ${
        isActive
          ? "bg-ink/[0.07] text-ink ring-1 ring-ink/[0.06] ring-inset"
          : "text-ink/50 hover:bg-ink/[0.04] hover:text-ink/85"
      }`}
    >
      <span aria-hidden className="w-3 shrink-0" />
      <Icon
        className={`size-3.5 shrink-0 ${isActive ? "text-ink/85" : "text-ink/25"}`}
        strokeWidth={1.75}
      />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

type ExplorerProps = {
  tree: FolderNode;
  activePath: string;
  onSelect: (path: string) => void;
  /** Right-click asks the assistant about the file or folder under the pointer. */
  onAskAi: (path: string, kind: "file" | "folder") => void;
  onCreate: (parentPath: string, name: string, kind: "file" | "folder") => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  onOpenFolder: () => void;
  onHide: () => void;
};

export default function Explorer({
  tree,
  activePath,
  onSelect,
  onAskAi,
  onCreate,
  onRename,
  onDelete,
  onOpenFolder,
  onHide,
}: ExplorerProps) {
  // Folders start collapsed: opening a project should show its top level, not
  // the whole tree. Creating or renaming inside a folder expands its ancestors.
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: ExplorerNode | null;
  } | null>(null);

  const existingPaths = allPaths(tree.children);
  existingPaths.add(tree.path);

  const toggleFolder = (path: string) =>
    setOpenPaths((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });

  const openMenu = (event: MouseEvent, target: ExplorerNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  };

  const validateName = (parentPath: string, name: string) => {
    if (!name || name.includes("/") || name === "." || name === "..") {
      return false;
    }

    return !existingPaths.has(joinPath(parentPath, name));
  };

  const startCreate = (parentPath: string, kind: "file" | "folder") => {
    setOpenPaths((current) => new Set([...current, ...ancestorPaths(parentPath)]));
    setDraft({ mode: "create", parentPath, kind });
    setMenu(null);
  };

  const startRename = (node: ExplorerNode) => {
    setOpenPaths((current) => new Set([...current, ...ancestorPaths(node.path)]));
    setDraft({ mode: "rename", path: node.path, name: node.name });
    setMenu(null);
  };

  const submitDraft = (name: string) => {
    if (!draft) {
      return;
    }

    if (draft.mode === "create") {
      if (!validateName(draft.parentPath, name)) {
        return;
      }

      onCreate(draft.parentPath, name, draft.kind);
    } else {
      if (name !== draft.name && !validateName(parentPathOf(draft.path), name)) {
        return;
      }

      onRename(draft.path, name);
    }

    setDraft(null);
  };

  const menuTarget = menu?.target ?? null;
  const targetFolderPath = menuTarget
    ? menuTarget.kind === "folder"
      ? menuTarget.path
      : parentPathOf(menuTarget.path)
    : tree.path;

  const menuItems: ContextMenuItem[] = menu
    ? [
        ...(menuTarget
          ? [
              {
                label:
                  menuTarget.kind === "folder"
                    ? "Ask AI about this folder"
                    : "Ask AI about this file",
                icon: Sparkles,
                onSelect: () => onAskAi(menuTarget.path, menuTarget.kind),
              } satisfies ContextMenuItem,
            ]
          : []),
        {
          label: "New File",
          icon: FilePlus,
          separatorBefore: Boolean(menuTarget),
          onSelect: () => startCreate(targetFolderPath, "file"),
        },
        {
          label: "New Folder",
          icon: FolderPlus,
          onSelect: () => startCreate(targetFolderPath, "folder"),
        },
        {
          label: "Rename",
          icon: Pencil,
          separatorBefore: true,
          disabled: !menuTarget,
          onSelect: () => {
            if (menuTarget) {
              startRename(menuTarget);
            }
          },
        },
        {
          label: "Copy Path",
          icon: Copy,
          disabled: !menuTarget,
          onSelect: () => {
            if (menuTarget) {
              void navigator.clipboard?.writeText(menuTarget.path).catch(() => {
                // Clipboard access can be denied; the menu just closes.
              });
            }
          },
        },
        {
          label: "Delete",
          icon: Trash2,
          separatorBefore: true,
          destructive: true,
          disabled: !menuTarget,
          onSelect: () => {
            if (menuTarget) {
              onDelete(menuTarget.path);
            }
          },
        },
      ]
    : [];

  const ctx: TreeContext = {
    activePath,
    openPaths,
    draft,
    onToggle: toggleFolder,
    onSelect: (path) => {
      setMenu(null);
      setDraft(null);
      onSelect(path);
    },
    onOpenMenu: openMenu,
    onSubmitDraft: submitDraft,
    onCancelDraft: () => setDraft(null),
    validateName,
  };

  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent px-3">
        <span className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/40">
          <Files className="size-3.5 text-ink/30" strokeWidth={1.75} />
          Explorer
        </span>
        <span className="flex min-w-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenFolder}
            aria-label="Open folder"
            title="Open folder"
            className="flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
          >
            <FolderOpen className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide explorer"
            title="Hide explorer"
            className="flex size-6 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
          >
            <PanelLeftClose className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>

      <nav
        aria-label="Explorer"
        onContextMenu={(event) => openMenu(event, null)}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      >
        {tree.children.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} ctx={ctx} />
        ))}

        {draft?.mode === "create" && draft.parentPath === tree.path && (
          <DraftInput
            depth={0}
            kind={draft.kind}
            initialValue=""
            validate={(name) => validateName(tree.path, name)}
            onSubmit={submitDraft}
            onCancel={() => setDraft(null)}
          />
        )}
      </nav>

      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3">
        <span
          className={`size-1.5 shrink-0 rounded-full ${activePath ? "bg-ink/40" : "bg-ink/15"}`}
        />
        <span className="truncate font-mono text-[10px] text-ink/30">
          {activePath || "no file open"}
        </span>
      </div>

      {menu && (
        <ExplorerContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
