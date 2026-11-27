#!/usr/bin/env node
// Stamps one version into every place the build reads it from, so the
// installers, the About dialog and the release all agree with the git tag.
//
//   node scripts/set-version.mjs v1.2.3      (a leading "v" is dropped)
//   node scripts/set-version.mjs 1.2.3-beta.1
//
// Updates package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];

if (!input) {
  console.error("Usage: node scripts/set-version.mjs <version | vX.Y.Z tag>");
  process.exit(1);
}

const version = input.replace(/^refs\/tags\//, "").replace(/^v/, "");

// SemVer: MAJOR.MINOR.PATCH with an optional -prerelease and +build part.
if (
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)
) {
  console.error(`"${input}" is not a version like v1.2.3 or v1.2.3-beta.1.`);
  process.exit(1);
}

function updateJson(path, update) {
  const file = resolve(root, path);
  const data = JSON.parse(readFileSync(file, "utf8"));
  update(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

updateJson("package.json", (data) => {
  data.version = version;
});

updateJson("src-tauri/tauri.conf.json", (data) => {
  data.version = version;
});

// Only the [package] version, never a dependency's.
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const stamped = cargo.replace(
  /(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
  `$1${version}$2`,
);

if (stamped === cargo && !cargo.includes(`version = "${version}"`)) {
  console.error("Could not find the [package] version in src-tauri/Cargo.toml.");
  process.exit(1);
}

writeFileSync(cargoPath, stamped);

console.log(`Version set to ${version}`);
