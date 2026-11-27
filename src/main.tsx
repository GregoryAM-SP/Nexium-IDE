import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { isTauri } from "./lib/tauriBridge";
import { initWorkspaceModels } from "./lib/workspaceModels";
import { applyTheme, loadThemeId } from "./lib/themes";
import "./index.css";

// Paint the saved theme before the first React render, so a light theme never
// flashes the default black window.
applyTheme(loadThemeId());
initWorkspaceModels(!isTauri());

// The webview's own right-click menu (Reload, Save as, Print, Inspect…) has no
// place in an editor, so it is suppressed for the whole window. This only stops
// the platform menu: a component's own onContextMenu handler still runs, so the
// explorer and the editor keep their menus. Capture phase runs before anything
// in the page, so no widget can leave a corner where the native menu leaks back.
window.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});

// The window turns WebView2's browser accelerators off (see
// `hand_shortcuts_to_the_page` in src-tauri/src/lib.rs) so that Ctrl+F and
// Ctrl+H open Monaco's find/replace widget over the file instead of the
// browser's find bar. That also takes Ctrl+R and F5 from WebView2, so the
// desktop window gets its reload key back here — the quickest way to pick up a
// frontend change while the shell's dev server runs without HMR.
if (isTauri()) {
  window.addEventListener("keydown", (event) => {
    const reload =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r";

    if (reload || event.key === "F5") {
      event.preventDefault();
      window.location.reload();
    }
  });
}

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The boot loader in index.html covers the window until the editor has painted
// its first frame (two animation frames after the render), then fades out.
// Animation frames never fire while the window is hidden or minimised, so a
// timer clears the loader as well, whichever comes first.
const BOOT_FADE_MS = 260;
const BOOT_FALLBACK_MS = 1500;

function hideBootLoader() {
  const loader = document.getElementById("boot-loader");

  if (!loader || loader.dataset.hidden === "true") {
    return;
  }

  loader.dataset.hidden = "true";
  window.setTimeout(() => loader.remove(), BOOT_FADE_MS);
}

requestAnimationFrame(() => requestAnimationFrame(hideBootLoader));
window.setTimeout(hideBootLoader, BOOT_FALLBACK_MS);
