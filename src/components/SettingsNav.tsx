import {
  ArrowLeft,
  GitBranch,
  Palette,
  Settings,
  Sparkles,
  Type,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SettingsSection =
  | "appearance"
  | "fonts"
  | "assistant"
  | "source-control";

const sections: {
  id: SettingsSection;
  label: string;
  hint: string;
  icon: LucideIcon;
}[] = [
  { id: "appearance", label: "Appearance", hint: "themes", icon: Palette },
  { id: "fonts", label: "Fonts", hint: "in use", icon: Type },
  { id: "assistant", label: "AI providers", hint: "keys · models", icon: Sparkles },
  { id: "source-control", label: "Source control", hint: "identity", icon: GitBranch },
];

type SettingsNavProps = {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onClose: () => void;
};

export default function SettingsNav({
  section,
  onSelect,
  onClose,
}: SettingsNavProps) {
  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line bg-gradient-to-b from-ink/[0.02] to-transparent px-3">
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink/40">
          <Settings className="size-3.5 shrink-0 text-ink/30" strokeWidth={1.75} />
          Settings
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to editor"
          title="Back to editor"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink/30 transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <nav
        aria-label="Settings sections"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {sections.map((item) => {
          const active = item.id === section;
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left transition-colors duration-150 ${
                active
                  ? "bg-ink/[0.07] text-ink ring-1 ring-ink/[0.06] ring-inset"
                  : "text-ink/55 hover:bg-ink/[0.04] hover:text-ink/85"
              }`}
            >
              <Icon
                className={`size-3.5 shrink-0 ${
                  active ? "text-ink/85" : "text-ink/30"
                }`}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[11.5px]">
                {item.label}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-ink/20">
                {item.hint}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-line px-3">
        <span className="size-1.5 shrink-0 rounded-full bg-ink/40" />
        <span className="truncate font-mono text-[9.5px] text-ink/25">
          saved on this machine
        </span>
      </div>
    </aside>
  );
}
