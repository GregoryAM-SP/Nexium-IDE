// Makes sure an update is taken from the same kind of installer this copy was
// installed with. The updater looks for `{os}-{arch}-{installer}` in
// latest.json and silently falls back to `{os}-{arch}` when that entry is
// missing, which would hand an MSI install the NSIS .exe (a second, separate
// installation) or a .deb install the AppImage. This refuses those cases.

/** How this copy was installed, as reported by the `install_kind` command. */
export type InstallKind = {
  /** The updater's platform key, e.g. `windows-x86_64`. */
  target: string | null;
  /** `nsis`, `msi`, `appimage`, `deb`, `rpm` or `app`. */
  installer: string | null;
};

type Installer = {
  label: string;
  /** What the download's file name must look like. */
  file: RegExp;
};

export const INSTALLERS: Record<string, Installer> = {
  nsis: { label: "Windows installer (.exe)", file: /\.exe$|\.nsis\.zip$/i },
  msi: { label: "Windows MSI (.msi)", file: /\.msi$|\.msi\.zip$/i },
  appimage: { label: "AppImage", file: /\.AppImage(\.tar\.gz)?$/i },
  deb: { label: "Debian package (.deb)", file: /\.deb$/i },
  rpm: { label: "RPM package (.rpm)", file: /\.rpm$/i },
  app: { label: "macOS app", file: /\.app\.tar\.gz$/i },
};

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return url.split("/").pop() ?? url;
  }
}

/**
 * Returns why the update must not be downloaded, or null when the manifest
 * has an entry for exactly this installer type and version.
 */
export function updateTargetProblem(
  manifest: Record<string, unknown>,
  version: string,
  kind: InstallKind,
): string | null {
  const installer = kind.installer ? INSTALLERS[kind.installer] : undefined;

  if (!kind.target || !kind.installer || !installer) {
    return "This copy was not installed from a Nexium Studio installer, so it cannot update itself. Download the new version from the releases page.";
  }

  const manifestVersion = String(manifest.version ?? "").replace(/^v/, "");

  if (manifestVersion !== version.replace(/^v/, "")) {
    return `The update manifest describes ${manifestVersion || "no version"}, not ${version}.`;
  }

  const platforms =
    manifest.platforms && typeof manifest.platforms === "object"
      ? (manifest.platforms as Record<string, { url?: unknown; signature?: unknown }>)
      : {};
  const key = `${kind.target}-${kind.installer}`;
  const entry = platforms[key];

  if (!entry || typeof entry.url !== "string" || typeof entry.signature !== "string") {
    return `Version ${version} has no ${installer.label} update for ${kind.target}, so it was not downloaded. Install it from the releases page.`;
  }

  const name = fileName(entry.url);

  if (!installer.file.test(name)) {
    return `The ${installer.label} update points at "${name}", which is a different kind of installer, so it was not downloaded.`;
  }

  return null;
}
