import { Lock, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type DeviceId = "desktop" | "laptop" | "tablet" | "mobile";

type Device = {
  label: string;
  /** The CSS viewport the page is laid out at, portrait for handhelds. */
  width: number;
  height: number;
};

export const DEVICES: Record<DeviceId, Device> = {
  desktop: { label: "Desktop", width: 1920, height: 1080 },
  laptop: { label: "Laptop", width: 1366, height: 768 },
  tablet: { label: "Tablet", width: 768, height: 1024 },
  mobile: { label: "Mobile", width: 390, height: 844 },
};

/** Browser window chrome shown above the page on desktop and laptop. */
const TOOLBAR = 44;

type DeviceFrameProps = {
  device: DeviceId;
  /** Tablets and phones can be turned sideways. */
  landscape: boolean;
  url: string;
  /** Bumped to reload the page. */
  nonce: number;
  /** Off while the panel is being resized, so the frame cannot eat the drag. */
  interactive: boolean;
  onReload: () => void;
};

/**
 * Lays the page out at the device's real resolution, so media queries and
 * Bootstrap breakpoints behave as on that device, then scales the whole
 * device, frame included, down to fit the panel.
 */
export default function DeviceFrame({
  device,
  landscape,
  url,
  nonce,
  interactive,
  onReload,
}: DeviceFrameProps) {
  const host = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = host.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() =>
      setSpace({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const spec = DEVICES[device];
  const handheld = device === "tablet" || device === "mobile";
  const turned = handheld && landscape;
  const screen = {
    width: turned ? spec.height : spec.width,
    height: turned ? spec.width : spec.height,
  };

  // Everything below is in device pixels; one transform scales it all.
  let body: ReactNode;
  let outer: { width: number; height: number };

  const page = (
    <iframe
      key={`${url}#${nonce}`}
      src={url}
      title={`Website preview (${spec.label})`}
      // Everything a page needs, but it can never navigate the IDE.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      style={{
        width: screen.width,
        height: screen.height,
        pointerEvents: interactive ? undefined : "none",
      }}
      className="block border-0 bg-white"
    />
  );

  if (!handheld) {
    const bezel = device === "desktop" ? 28 : 22;
    const browser = (
      <div className="flex flex-col overflow-hidden rounded-[10px] bg-[#1f2023]">
        <div
          style={{ height: TOOLBAR }}
          className="flex items-center gap-4 border-b border-black/40 bg-[#2b2c30] px-4"
        >
          <span className="flex gap-2">
            <span className="size-3.5 rounded-full bg-[#ff5f57]" />
            <span className="size-3.5 rounded-full bg-[#febc2e]" />
            <span className="size-3.5 rounded-full bg-[#28c840]" />
          </span>
          <button
            type="button"
            onClick={onReload}
            title="Reload"
            className="flex size-7 items-center justify-center rounded-md text-white/45 hover:bg-white/10 hover:text-white/80"
          >
            <RotateCw className="size-4" strokeWidth={2} />
          </button>
          <span className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full bg-[#1b1c1f] px-4 font-sans text-[15px] text-white/60">
            <Lock className="size-3.5 shrink-0 text-white/35" strokeWidth={2} />
            <span className="truncate">{url}</span>
          </span>
        </div>
        {page}
      </div>
    );

    if (device === "desktop") {
      // A monitor: even bezel, a neck and a foot.
      const monitor = {
        width: screen.width + bezel * 2,
        height: screen.height + TOOLBAR + bezel * 2,
      };
      outer = { width: monitor.width, height: monitor.height + 230 };
      body = (
        <div className="flex flex-col items-center">
          <div
            style={{ padding: bezel, width: monitor.width }}
            className="rounded-[26px] bg-[#0c0c0e] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] ring-2 ring-white/[0.08]"
          >
            {browser}
          </div>
          <div className="h-[170px] w-[260px] bg-gradient-to-b from-[#2a2b2f] to-[#1a1b1e] [clip-path:polygon(18%_0,82%_0,100%_100%,0_100%)]" />
          <div className="h-[60px] w-[620px] rounded-t-[14px] rounded-b-[30px] bg-gradient-to-b from-[#2e2f33] to-[#18191c] ring-1 ring-white/[0.06]" />
        </div>
      );
    } else {
      // A laptop: thin bezel with a camera, a hinge and a wider base.
      const lid = {
        width: screen.width + bezel * 2,
        height: screen.height + TOOLBAR + bezel * 2 + 12,
      };
      const baseWidth = lid.width + 220;
      outer = { width: baseWidth, height: lid.height + 34 };
      body = (
        <div className="flex flex-col items-center">
          <div
            style={{ padding: bezel, paddingTop: bezel + 12, width: lid.width }}
            className="relative rounded-t-[30px] rounded-b-[6px] bg-[#0c0c0e] ring-2 ring-white/[0.1]"
          >
            <span className="absolute top-[13px] left-1/2 size-2.5 -translate-x-1/2 rounded-full bg-[#26272b]" />
            {browser}
          </div>
          <div
            style={{ width: baseWidth }}
            className="relative h-[34px] rounded-t-[4px] rounded-b-[26px] bg-gradient-to-b from-[#3a3b40] via-[#2a2b2f] to-[#16171a] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
          >
            <span className="absolute top-0 left-1/2 h-[12px] w-[240px] -translate-x-1/2 rounded-b-[12px] bg-[#1c1d20]" />
          </div>
        </div>
      );
    }
  } else {
    const phone = device === "mobile";
    // Phones have a taller bezel for the camera island; tablets are even.
    const side = phone ? 14 : 26;
    const ends = phone ? 14 : 26;
    const radius = phone ? 58 : 38;
    outer = {
      width: screen.width + side * 2,
      height: screen.height + ends * 2,
    };
    body = (
      <div
        style={{ padding: `${ends}px ${side}px`, borderRadius: radius }}
        className="relative bg-[#0c0c0e] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] ring-2 ring-white/[0.1]"
      >
        <div style={{ borderRadius: radius - side }} className="overflow-hidden">
          {page}
        </div>
        {phone && !turned && (
          <span className="pointer-events-none absolute top-[24px] left-1/2 h-[30px] w-[110px] -translate-x-1/2 rounded-full bg-black" />
        )}
        {phone && turned && (
          <span className="pointer-events-none absolute top-1/2 left-[24px] h-[110px] w-[30px] -translate-y-1/2 rounded-full bg-black" />
        )}
        {!phone && (
          <span
            className={`pointer-events-none absolute size-2.5 rounded-full bg-[#26272b] ${
              turned ? "top-1/2 left-[8px] -translate-y-1/2" : "top-[8px] left-1/2 -translate-x-1/2"
            }`}
          />
        )}
      </div>
    );
  }

  const margin = 24;
  const scale =
    space.width > 0 && space.height > 0
      ? Math.min(
          1,
          (space.width - margin * 2) / outer.width,
          (space.height - margin * 2 - 22) / outer.height,
        )
      : 0;

  return (
    <div
      ref={host}
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-[radial-gradient(80%_60%_at_50%_40%,color-mix(in_srgb,var(--color-ink)_5%,transparent),transparent_75%)]"
    >
      {scale > 0 && (
        <>
          <div
            style={{ width: outer.width * scale, height: outer.height * scale }}
            className="relative shrink-0"
          >
            <div
              style={{
                width: outer.width,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
              className="absolute top-0 left-0"
            >
              {body}
            </div>
          </div>
          <p className="mt-2 shrink-0 font-mono text-[10px] text-ink/30">
            {spec.label} · {screen.width}×{screen.height} · {Math.round(scale * 100)}%
          </p>
        </>
      )}
    </div>
  );
}
