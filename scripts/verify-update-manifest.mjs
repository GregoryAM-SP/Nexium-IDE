#!/usr/bin/env node
// Checks a release's latest.json before it is published, so every installed
// copy of Nexium Studio updates from the same kind of installer it came from.
//
//   node scripts/verify-update-manifest.mjs v1.2.3 [--repo owner/name]
//
// Needs the GitHub CLI (`gh`), signed in. Fails when any installer type:
//   - has no `{os}-{arch}-{installer}` entry (the updater would fall back to the
//     generic entry and, say, give an MSI install the NSIS .exe),
//   - points at a different kind of file, or at a file not in this release,
//   - carries a signature that is not the one in that file's .sig asset,
// or when the manifest's version is not the tag's.
//
// Keep REQUIRED in step with the bundles built in .github/workflows/release.yml.
import { execFileSync } from "node:child_process";

const REQUIRED = [
  { key: "windows-x86_64-nsis", file: /-setup\.exe$/i, fallback: "windows-x86_64" },
  // WiX only takes numeric versions, so pre-releases ship without an MSI.
  { key: "windows-x86_64-msi", file: /\.msi$/i, stableOnly: true },
  { key: "linux-x86_64-appimage", file: /\.AppImage$/i, fallback: "linux-x86_64" },
  { key: "linux-x86_64-deb", file: /\.deb$/i },
  { key: "linux-x86_64-rpm", file: /\.rpm$/i },
];

const args = process.argv.slice(2);
const tag = args.find((arg) => !arg.startsWith("--"));
const repoIndex = args.indexOf("--repo");
const repo = repoIndex >= 0 ? args[repoIndex + 1] : process.env.GITHUB_REPOSITORY;

if (!tag) {
  console.error("Usage: node scripts/verify-update-manifest.mjs <tag> [--repo owner/name]");
  process.exit(2);
}

const repoArgs = repo ? ["--repo", repo] : [];

function gh(...command) {
  return execFileSync("gh", [...command, ...repoArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** A release asset's text, read straight from GitHub. */
function assetText(name) {
  return gh("release", "download", tag, "--pattern", name, "--output", "-");
}

const release = JSON.parse(gh("release", "view", tag, "--json", "assets,isPrerelease"));
const assets = new Set(release.assets.map((asset) => asset.name));
const version = tag.replace(/^v/, "");
const problems = [];

if (!assets.has("latest.json")) {
  console.error(`::error::${tag} has no latest.json, so installed copies cannot update.`);
  process.exit(1);
}

const manifest = JSON.parse(assetText("latest.json"));
const platforms = manifest.platforms ?? {};

if (String(manifest.version ?? "").replace(/^v/, "") !== version) {
  problems.push(`latest.json says version ${manifest.version}, but the tag is ${tag}.`);
}

function fileOf(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
}

for (const rule of REQUIRED) {
  if (rule.stableOnly && release.isPrerelease) {
    continue;
  }

  const before = problems.length;
  const entry = platforms[rule.key];

  if (!entry?.url || !entry?.signature) {
    problems.push(`${rule.key}: missing from latest.json.`);
    continue;
  }

  const name = fileOf(entry.url);

  if (!rule.file.test(name)) {
    problems.push(`${rule.key}: points at "${name}", which is the wrong kind of installer.`);
  }

  // tauri-action links through /releases/latest/download/, which resolves
  // to this release once it is published (latest.json is read from there too).
  const fromThisRelease =
    entry.url.includes(`/releases/download/${tag}/`) ||
    entry.url.includes("/releases/latest/download/");

  if (!fromThisRelease) {
    problems.push(`${rule.key}: downloads from another release: ${entry.url}`);
  }

  if (!assets.has(name)) {
    problems.push(`${rule.key}: "${name}" is not a file in ${tag}.`);
  } else if (!assets.has(`${name}.sig`)) {
    problems.push(`${rule.key}: "${name}.sig" is missing, so the signature cannot be checked.`);
  } else if (assetText(`${name}.sig`).trim() !== entry.signature.trim()) {
    problems.push(`${rule.key}: the signature does not match ${name}.sig.`);
  }

  // Copies whose installer type is unknown use the generic entry; it must be
  // the same download as the default installer for that system.
  if (rule.fallback && platforms[rule.fallback]?.url !== entry.url) {
    problems.push(`${rule.fallback}: should point at the same file as ${rule.key}.`);
  }

  console.log(`${problems.length > before ? "!!" : "ok"} ${rule.key.padEnd(24)} ${name}`);
}

const unknown = Object.keys(platforms).filter(
  (key) => !REQUIRED.some((rule) => rule.key === key || rule.fallback === key),
);

if (unknown.length > 0) {
  console.log(`Other entries (not checked): ${unknown.join(", ")}`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

console.log(`latest.json for ${tag} sends every installer type its own update.`);
