import { Check } from "lucide-react";

import { THEMES } from "../lib/themes";

type AppearanceSettingsProps = {
  value: string;
  onChange: (themeId: string) => void;
};

export default function AppearanceSettings({
  value,
  onChange,
}: AppearanceSettingsProps) {
  return (
    <div className="h-full overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[820px] px-10 py-10">
        <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-ink/90">
          Appearance
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[12px] leading-relaxed text-ink/40">
          Twenty-four palettes for the whole window. The panels, hairlines, text
          and the editor itself are all mixed from the chosen theme, and the
          choice is kept on this machine.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {THEMES.map((theme) => {
            const active = theme.id === value;

            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => onChange(theme.id)}
                aria-pressed={active}
                className={`group flex flex-col overflow-hidden rounded-xl border text-left transition-colors duration-150 ${
                  active
                    ? "border-line-strong bg-ink/[0.05]"
                    : "border-line hover:border-line-strong hover:bg-ink/[0.03]"
                }`}
              >
                <span
                  aria-hidden
                  className="relative block h-[68px] w-full overflow-hidden"
                  style={{ backgroundColor: theme.bg }}
                >
                  <span className="absolute inset-x-3 top-3 flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: theme.accent }}
                    />
                    <span
                      className="h-1 w-10 rounded-full"
                      style={{ backgroundColor: theme.fg, opacity: 0.45 }}
                    />
                    <span
                      className="ml-auto h-1 w-5 rounded-full"
                      style={{ backgroundColor: theme.fg, opacity: 0.18 }}
                    />
                  </span>
                  <span className="absolute inset-x-3 top-[30px] flex flex-col gap-1.5">
                    <span
                      className="h-1.5 w-3/5 rounded-sm"
                      style={{ backgroundColor: theme.fg, opacity: 0.3 }}
                    />
                    <span
                      className="h-1.5 w-2/5 rounded-sm"
                      style={{ backgroundColor: theme.accent, opacity: 0.75 }}
                    />
                    <span
                      className="h-1.5 w-1/2 rounded-sm"
                      style={{ backgroundColor: theme.fg, opacity: 0.18 }}
                    />
                  </span>
                </span>

                <span className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
                  <span className="truncate text-[11.5px] text-ink/80">
                    {theme.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink/25">
                      {theme.scheme}
                    </span>
                    {active && <Check className="size-3.5 text-ink" />}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
