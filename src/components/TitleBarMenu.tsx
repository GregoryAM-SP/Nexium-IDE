import {
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderCog,
  GitBranch,
  Info,
  MessageSquare,
  RefreshCw,
  PanelLeft,
  Redo2,
  Replace,
  Search,
  Undo2,
} from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";

import ExplorerContextMenu from "./ExplorerContextMenu";
import type { ContextMenuItem } from "./ExplorerContextMenu";

type MenuName = "file" | "edit" | "view" | "help";

type TitleBarMenuProps = {
  projectName: string;
  /** Editing commands need an open text file in the editor. */
  editDisabled: boolean;
  explorerOpen: boolean;
  sourceControlOpen: boolean;
  assistantOpen: boolean;
  previewOpen: boolean;
  /** Only Markdown and SVG files have a preview pane. */
  previewAvailable: boolean;
  onToggleExplorer: () => void;
  onToggleSourceControl: () => void;
  onToggleAssistant: () => void;
  onTogglePreview: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onRevealExplorer: () => void;
  /** Project settings need an open folder. */
  projectSettingsDisabled: boolean;
  onProjectSettings: () => void;
  onAbout: () => void;
  onCheckUpdates: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFind: () => void;
  onReplace: () => void;
};

const triggerClass =
  "flex h-[26px] shrink-0 items-center rounded-md px-2 text-[11.5px] text-ink/55 transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink/85";

/**
 * The window has no native menu bar. The project chip is the way in: the menu
 * bar exists only while one of its menus is open, so the title bar stays quiet
 * until the project is clicked.
 */
export default function TitleBarMenu({
  projectName,
  editDisabled,
  explorerOpen,
  sourceControlOpen,
  assistantOpen,
  previewOpen,
  previewAvailable,
  onToggleExplorer,
  onToggleSourceControl,
  onToggleAssistant,
  onTogglePreview,
  onNewProject,
  onOpenProject,
  onRevealExplorer,
  projectSettingsDisabled,
  onProjectSettings,
  onAbout,
  onCheckUpdates,
  onUndo,
  onRedo,
  onFind,
  onReplace,
}: TitleBarMenuProps) {
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<MenuName, HTMLButtonElement | null>>>(
    {},
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    setAnchor(null);
  }, []);

  const openFromTrigger = useCallback(
    (name: MenuName) => (event: MouseEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();

      setMenu(name);
      setAnchor({ x: rect.left, y: rect.bottom + 4 });
    },
    [],
  );

  // The chip opens File before the bar is on screen, so that trigger has no
  // rect to anchor to yet; it is measured once the bar has been laid out.
  useLayoutEffect(() => {
    if (!menu || anchor) {
      return;
    }

    const trigger = triggers.current[menu];

    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();

    setAnchor({ x: rect.left, y: rect.bottom + 4 });
  }, [menu, anchor]);

  const fileItems: ContextMenuItem[] = [
    { label: "New Project…", icon: FolderPlus, onSelect: onNewProject },
    { label: "Open Project…", icon: FolderOpen, onSelect: onOpenProject },
    {
      label: "Project Settings…",
      icon: FolderCog,
      onSelect: onProjectSettings,
      disabled: projectSettingsDisabled,
      separatorBefore: true,
    },
    {
      label: "Reveal in Explorer",
      icon: Folder,
      onSelect: onRevealExplorer,
      separatorBefore: true,
    },
  ];

  const editItems: ContextMenuItem[] = [
    { label: "Undo", icon: Undo2, onSelect: onUndo, disabled: editDisabled },
    { label: "Redo", icon: Redo2, onSelect: onRedo, disabled: editDisabled },
    {
      label: "Find",
      icon: Search,
      onSelect: onFind,
      disabled: editDisabled,
      separatorBefore: true,
    },
    {
      label: "Find and Replace",
      icon: Replace,
      onSelect: onReplace,
      disabled: editDisabled,
    },
  ];

  const viewItems: ContextMenuItem[] = [
    {
      label: explorerOpen ? "Hide Explorer" : "Show Explorer",
      icon: PanelLeft,
      onSelect: onToggleExplorer,
    },
    {
      label: sourceControlOpen ? "Hide Source Control" : "Show Source Control",
      icon: GitBranch,
      onSelect: onToggleSourceControl,
    },
    {
      label: assistantOpen ? "Hide Assistant" : "Show Assistant",
      icon: MessageSquare,
      onSelect: onToggleAssistant,
    },
    {
      label: previewOpen ? "Hide Preview" : "Show Preview",
      icon: Eye,
      onSelect: onTogglePreview,
      disabled: !previewAvailable,
      separatorBefore: true,
    },
  ];

  const helpItems: ContextMenuItem[] = [
    { label: "Check for Updates…", icon: RefreshCw, onSelect: onCheckUpdates },
    { label: "About Nexium", icon: Info, onSelect: onAbout, separatorBefore: true },
  ];

  const items =
    menu === "file"
      ? fileItems
      : menu === "edit"
        ? editItems
        : menu === "view"
          ? viewItems
          : helpItems;

  return (
    <div ref={barRef} className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          if (menu) {
            closeMenu();
            return;
          }

          setAnchor(null);
          setMenu("file");
        }}
        title="Project menu"
        className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11.5px] transition-colors duration-150 ${
          menu
            ? "border-ink/15 bg-ink/[0.06] text-ink/85"
            : "border-ink/[0.07] bg-ink/[0.02] text-ink/55 hover:border-ink/15 hover:bg-ink/[0.05] hover:text-ink/85"
        }`}
      >
        <Folder className="size-3.5 shrink-0 text-ink/30" strokeWidth={1.75} />
        <span className="max-w-[12rem] truncate">{projectName}</span>
      </button>

      {menu && (
        <>
          <button
            ref={(element) => {
              triggers.current.file = element;
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu === "file"}
            onClick={openFromTrigger("file")}
            className={triggerClass}
          >
            File
          </button>

          <button
            ref={(element) => {
              triggers.current.edit = element;
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu === "edit"}
            onClick={openFromTrigger("edit")}
            className={triggerClass}
          >
            Edit
          </button>

          <button
            ref={(element) => {
              triggers.current.view = element;
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu === "view"}
            onClick={openFromTrigger("view")}
            className={triggerClass}
          >
            View
          </button>

          <button
            ref={(element) => {
              triggers.current.help = element;
            }}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu === "help"}
            onClick={openFromTrigger("help")}
            className={triggerClass}
          >
            Help
          </button>

          {/* Outside the draggable header: a fixed menu inside it would be
              part of the window's drag region. */}
          {createPortal(
            <ExplorerContextMenu
              x={anchor?.x ?? 0}
              y={anchor?.y ?? 0}
              label={
                menu === "file"
                  ? "File menu"
                  : menu === "edit"
                    ? "Edit menu"
                    : menu === "view"
                      ? "View menu"
                      : "Help menu"
              }
              items={items}
              boundary={barRef}
              onClose={closeMenu}
            />,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
