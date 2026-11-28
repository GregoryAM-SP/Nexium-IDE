import { Globe, Hammer, Sparkles, SquareTerminal } from "lucide-react";

import { RailButton } from "./ActivityRail";

type AssistantRailProps = {
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  /** Only shown for a Gradle build. */
  gradleAvailable: boolean;
  gradleOpen: boolean;
  /** Runnable tasks found; drawn as a small badge on the button. */
  gradleRunnable: number;
  onToggleGradle: () => void;
  /** Shown when the folder has a website to preview. */
  previewAvailable: boolean;
  previewOpen: boolean;
  /** A dev or live server is running; drawn as a dot on the button. */
  previewRunning: boolean;
  onTogglePreview: () => void;
  /** Shown when the folder has a program to run (Rust, Go, .NET, Python…). */
  runAvailable: boolean;
  runOpen: boolean;
  /** A program is running; drawn as a dot on the button. */
  runRunning: boolean;
  onToggleRun: () => void;
};

/**
 * The right edge holds the assistant, plus the Gradle tasks and the website
 * preview when the open folder has them.
 */
export default function AssistantRail({
  assistantOpen,
  onToggleAssistant,
  gradleAvailable,
  gradleOpen,
  gradleRunnable,
  onToggleGradle,
  previewAvailable,
  previewOpen,
  previewRunning,
  onTogglePreview,
  runAvailable,
  runOpen,
  runRunning,
  onToggleRun,
}: AssistantRailProps) {
  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-l border-line bg-rail py-3">
      <RailButton
        active={assistantOpen}
        label={assistantOpen ? "Hide AI assistant" : "Show AI assistant"}
        icon={Sparkles}
        onClick={onToggleAssistant}
      />

      {gradleAvailable && (
        <div className="relative">
          <RailButton
            active={gradleOpen}
            label={gradleOpen ? "Hide Gradle tasks" : "Show Gradle tasks"}
            icon={Hammer}
            onClick={onToggleGradle}
          />
          {gradleRunnable > 0 && !gradleOpen && (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink px-1 font-mono text-[8.5px] leading-none text-app"
            >
              {gradleRunnable}
            </span>
          )}
        </div>
      )}

      {previewAvailable && (
        <div className="relative">
          <RailButton
            active={previewOpen}
            label={previewOpen ? "Hide website preview" : "Show website preview"}
            icon={Globe}
            onClick={onTogglePreview}
          />
          {previewRunning && (
            <span
              aria-hidden
              title="A preview server is running"
              className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-rail"
            />
          )}
        </div>
      )}

      {runAvailable && (
        <div className="relative">
          <RailButton
            active={runOpen}
            label={runOpen ? "Hide the Run panel" : "Run the program"}
            icon={SquareTerminal}
            onClick={onToggleRun}
          />
          {runRunning && (
            <span
              aria-hidden
              title="A program is running"
              className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-rail"
            />
          )}
        </div>
      )}
    </div>
  );
}
