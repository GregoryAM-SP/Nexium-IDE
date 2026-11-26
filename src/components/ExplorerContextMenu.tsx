import type { LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

export type ContextMenuItem = {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
};

type ExplorerContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Announced to screen readers; the title bar reuses this menu. */
  label?: string;
  /**
   * A surface that belongs to the menu even though it sits outside it — the
   * title bar's triggers. Clicking there switches menus instead of closing.
   */
  boundary?: RefObject<HTMLElement | null>;
};

const menuWidth = 212;

export default function ExplorerContextMenu({
  x,
  y,
  items,
  onClose,
  label = "Explorer actions",
  boundary,
}: ExplorerContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        !ref.current?.contains(target) &&
        !boundary?.current?.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Claim the key so a global Escape handler does not also react.
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [boundary, onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, []);

  const separators = items.filter((item) => item.separatorBefore).length;
  const height = items.length * 32 + separators * 9 + 12;
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left, top, width: menuWidth }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 rounded-xl border border-ink/[0.09] bg-raised/95 p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
    >
      {items.map((item) => {
        const Icon = item.icon;

        return (
          <div key={item.label}>
            {item.separatorBefore && (
              <div className="my-1 h-px bg-ink/[0.07]" />
            )}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
              className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] outline-none transition-colors duration-100 disabled:cursor-default disabled:text-ink/20 ${
                item.destructive
                  ? "text-red-400/90 hover:bg-red-500/10 hover:text-red-300 focus:bg-red-500/10"
                  : "text-ink/65 hover:bg-ink/[0.07] hover:text-ink focus:bg-ink/[0.07] focus:text-ink"
              }`}
            >
              <Icon
                className="size-3.5 shrink-0 opacity-70"
                strokeWidth={1.75}
              />
              {item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
