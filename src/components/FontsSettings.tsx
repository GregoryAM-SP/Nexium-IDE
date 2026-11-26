const PANGRAM = "The quick brown fox jumps over the lazy dog";

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS =
  '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

type Face = {
  name: string;
  usedBy: string;
  family: string;
  file: string;
  weights: { label: string; weight: number }[];
};

const faces: Face[] = [
  {
    name: "JetBrains Mono",
    usedBy: "editor · diffs · explorer · every monospaced label",
    family: MONO,
    file: "public/fonts/JetBrains-Mono-400.woff2",
    weights: [
      { label: "Regular 400", weight: 400 },
      { label: "Medium 500", weight: 500 },
    ],
  },
  {
    name: "Inter",
    usedBy: "panels · menus · assistant",
    family: SANS,
    file: "public/fonts/Inter-400.woff2",
    weights: [
      { label: "Regular 400", weight: 400 },
      { label: "Medium 500", weight: 500 },
      { label: "Semibold 600", weight: 600 },
    ],
  },
];

export default function FontsSettings() {
  return (
    <div className="h-full overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[820px] px-10 py-10">
        <h1 className="text-[16px] font-semibold tracking-[-0.015em] text-ink/90">
          Fonts
        </h1>
        <p className="mt-1.5 max-w-[60ch] text-[12px] leading-relaxed text-ink/40">
          The two faces the window ships with, each shown with the same sentence
          so their shapes can be compared.
        </p>

        <div className="mt-8 space-y-4">
          {faces.map((face) => (
            <section
              key={face.name}
              className="overflow-hidden rounded-xl border border-line"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-[12.5px] font-semibold text-ink/80">
                    {face.name}
                  </h2>
                  <p className="mt-0.5 font-mono text-[10px] text-ink/30">
                    {face.usedBy}
                  </p>
                </div>
                <span className="shrink-0 rounded bg-ink/[0.06] px-1.5 font-mono text-[9px] leading-4 text-ink/35">
                  bundled
                </span>
              </div>

              <div className="divide-y divide-line">
                {face.weights.map((weight) => (
                  <div key={weight.label} className="px-4 py-3">
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink/25">
                      {weight.label}
                    </span>
                    <p
                      className="mt-1.5 truncate text-[17px] leading-[1.55] text-ink/85"
                      style={{ fontFamily: face.family, fontWeight: weight.weight }}
                    >
                      {PANGRAM}
                    </p>
                  </div>
                ))}
              </div>

              <p className="border-t border-line px-4 py-2 font-mono text-[9.5px] text-ink/20">
                {face.file}
              </p>
            </section>
          ))}
        </div>

        <p className="mt-8 max-w-[60ch] text-[10.5px] leading-relaxed text-ink/25">
          Both faces are bundled with the app, so the window renders the same on
          every machine instead of borrowing whatever the system installs.
        </p>
      </div>
    </div>
  );
}
