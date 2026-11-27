import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import { isTauri, toError } from "./tauriBridge";
import {
  detectWeb,
  startDevServer,
  startLiveServer,
  stopDevServer,
  stopLiveServer,
  webStatus,
} from "./web";
import type { DevStatus, WebInfo } from "./web";

const MAX_LOGS = 400;

export type WebPreview = {
  info: WebInfo | null;
  dev: DevStatus | null;
  /** The live server's origin while it runs. */
  live: string | null;
  logs: string[];
  /** Set when the dev server stopped on its own, with its exit code. */
  exited: { code: number | null } | null;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  startDev: (dir: string, script: string) => Promise<void>;
  stopDev: () => Promise<void>;
  startLive: () => Promise<void>;
  stopLive: () => Promise<void>;
};

/**
 * Website preview state for the open folder: what can be previewed, and the
 * dev server and live server running for it. The servers live in the Rust
 * side; this mirrors them and follows their events.
 */
export function useWebPreview(
  enabled: boolean,
  workspaceKey: number,
): WebPreview {
  const [info, setInfo] = useState<WebInfo | null>(null);
  const [dev, setDev] = useState<DevStatus | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [exited, setExited] = useState<{ code: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setInfo(null);
      return;
    }

    try {
      setInfo(await detectWeb());
    } catch (cause) {
      setInfo(null);
      setError(toError(cause, "The project could not be checked.").message);
    }
  }, [enabled]);

  // A new folder: the Rust side has already stopped the old servers.
  useEffect(() => {
    setExited(null);
    setError(null);
    void refresh();
    void webStatus().then((status) => {
      setDev(status.dev);
      setLive(status.live);
      setLogs(status.logs);
    });
  }, [refresh, workspaceKey]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let active = true;
    const stops: (() => void)[] = [];
    const attach = <T,>(event: string, handle: (payload: T) => void) => {
      void listen<T>(event, (incoming) => handle(incoming.payload)).then(
        (stop) => (active ? stops.push(stop) : stop()),
      );
    };

    attach<{ line: string }>("web:log", ({ line }) => {
      setLogs((current) =>
        current.length >= MAX_LOGS
          ? [...current.slice(current.length - MAX_LOGS + 1), line]
          : [...current, line],
      );
    });

    attach<string>("web:url", (url) => {
      setDev((current) => (current ? { ...current, url } : current));
    });

    attach<{ code: number | null }>("web:exit", (payload) => {
      setDev(null);
      setExited(payload);
    });

    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (cause) {
      setError(toError(cause, "That did not work.").message);
    } finally {
      setBusy(false);
    }
  }, []);

  const startDev = useCallback(
    (dir: string, script: string) =>
      run(async () => {
        setLogs([]);
        setExited(null);
        setDev(await startDevServer(dir, script));
      }),
    [run],
  );

  const stopDev = useCallback(
    () =>
      run(async () => {
        await stopDevServer();
        setDev(null);
      }),
    [run],
  );

  const startLive = useCallback(
    () =>
      run(async () => {
        setLive(await startLiveServer());
      }),
    [run],
  );

  const stopLive = useCallback(
    () =>
      run(async () => {
        await stopLiveServer();
        setLive(null);
      }),
    [run],
  );

  return {
    info,
    dev,
    live,
    logs,
    exited,
    busy,
    error,
    refresh,
    startDev,
    stopDev,
    startLive,
    stopLive,
  };
}
