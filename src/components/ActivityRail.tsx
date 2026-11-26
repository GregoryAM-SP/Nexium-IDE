import { Files, GitBranch, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type ActivityRailProps = {
  explorerOpen: boolean;
  sourceControlOpen: boolean;
  settingsOpen: boolean;
  onToggleExplorer: () => void;
  onToggleSourceControl: () => void;
  onToggleSettings: () => void;
};

export function RailButton({
  active,
  label,
  icon: Icon,
  onClick,
  className = "",
}: {
  active: boolean;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`group relative flex size-9 items-center justify-center rounded-[10px] transition-all duration-150 ${
        active
          ? "bg-ink/[0.09] text-ink shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-ink)_6%,transparent)] ring-1 ring-ink/10 ring-inset"
          : "text-ink/35 hover:bg-ink/[0.05] hover:text-ink/90 hover:ring-1 hover:ring-ink/[0.06] hover:ring-inset"
      } ${className}`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-2 h-4 w-[2px] rounded-full bg-ink"
        />
      )}
      <Icon className="size-[17px]" strokeWidth={1.75} />
    </button>
  );
}

export default function ActivityRail({
  explorerOpen,
  sourceControlOpen,
  settingsOpen,
  onToggleExplorer,
  onToggleSourceControl,
  onToggleSettings,
}: ActivityRailProps) {
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-line bg-rail py-3">
      <RailButton
        active={explorerOpen}
        label={explorerOpen ? "Hide explorer" : "Show explorer"}
        icon={Files}
        onClick={onToggleExplorer}
      />

      <RailButton
        active={sourceControlOpen}
        label={
          sourceControlOpen ? "Hide source control" : "Show source control"
        }
        icon={GitBranch}
        onClick={onToggleSourceControl}
      />

      <div aria-hidden className="mt-auto mb-2 h-px w-5 bg-ink/[0.08]" />

      <RailButton
        active={settingsOpen}
        label={settingsOpen ? "Back to editor" : "Open settings"}
        icon={Settings}
        onClick={onToggleSettings}
      />
    </div>
  );
}
