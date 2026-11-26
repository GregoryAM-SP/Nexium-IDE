import { invoke, isTauri, toError } from "./tauriBridge";

/** Raster formats the editor shows as an image instead of text. */
const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
];

/** Web font files the editor shows as a specimen instead of text. */
const FONT_EXTENSIONS = ["woff2", "woff", "ttf", "otf"];

export function isImagePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  return IMAGE_EXTENSIONS.includes(extension);
}

export function isFontPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  return FONT_EXTENSIONS.includes(extension);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Browser builds have no files to read, so they draw a stand-in tile. */
function demoImage(path: string): string {
  const name = escapeXml(path.split("/").pop() ?? path);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0b0b0b"/><rect x="0.5" y="0.5" width="319" height="199" fill="none" stroke="rgba(255,255,255,0.08)"/><text x="160" y="105" fill="rgba(255,255,255,0.4)" font-family="monospace" font-size="13" text-anchor="middle">${name}</text></svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * A font file as a data URL so the webview can render it. The browser demo has
 * no binary face to read, so it returns null and the preview falls back to the
 * bundled mono face.
 */
export async function readFontUrl(path: string): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    const file = await invoke<{ mime: string; base64: string }>(
      "read_media_file",
      { path },
    );

    return `data:${file.mime};base64,${file.base64}`;
  } catch (cause) {
    throw toError(cause, "Could not open that font.");
  }
}

/** The file's bytes as a data URL, so the webview never needs disk access. */
export async function readImageUrl(path: string): Promise<string> {
  if (!isTauri()) {
    return demoImage(path);
  }

  try {
    const file = await invoke<{ mime: string; base64: string }>(
      "read_media_file",
      { path },
    );

    return `data:${file.mime};base64,${file.base64}`;
  } catch (cause) {
    throw toError(cause, "Could not open that image.");
  }
}
