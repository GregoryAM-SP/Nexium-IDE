import { Sparkles } from "lucide-react";

import { RailButton } from "./ActivityRail";

type AssistantRailProps = {
  assistantOpen: boolean;
  onToggleAssistant: () => void;
};

/** The right edge only has to open and close the assistant. */
export default function AssistantRail({
  assistantOpen,
  onToggleAssistant,
}: AssistantRailProps) {
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-l border-line bg-rail py-3">
      <RailButton
        active={assistantOpen}
        label={assistantOpen ? "Hide AI assistant" : "Show AI assistant"}
        icon={Sparkles}
        onClick={onToggleAssistant}
      />
    </div>
  );
}
