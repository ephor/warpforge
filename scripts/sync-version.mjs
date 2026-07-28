#!/usr/bin/env node

// Propagates the root package.json version — the one Changesets bumps — into
// every other manifest that has to agree with it before a release tag is cut.
// Editing the lockfiles textually keeps this runnable without a cargo
// toolchain, a registry index, or network access.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function write(path, contents) {
  writeFileSync(resolve(root, path), contents);
}

const version = JSON.parse(read("package.json")).version;

if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
  console.error(`root package.json version is not a stable X.Y.Z: ${version}`);
  process.exit(1);
}

// Replaces the `version` key of the `[package]` table only, so dependency
// versions further down the manifest are never touched.
function setCargoPackageVersion(path) {
  const contents = read(path);
  const updated = contents.replace(
    /(^\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms,
    `$1${version}$2`,
  );
  if (updated === contents) return false;
  write(path, updated);
  return true;
}

// Rewrites the `version` of one `[[package]]` entry in a Cargo lockfile.
function setCargoLockVersion(path, name) {
  const contents = read(path);
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]*(")`,
  );
  if (!pattern.test(contents)) {
    console.error(`missing: ${path} entry for ${name}`);
    process.exit(1);
  }
  const updated = contents.replace(pattern, `$1${version}$2`);
  if (updated === contents) return false;
  write(path, updated);
  return true;
}

function setJsonVersion(path) {
  const contents = read(path);
  const updated = contents.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (updated === contents) return false;
  write(path, updated);
  return true;
}

const targets = [
  ["Cargo.toml", () => setCargoPackageVersion("Cargo.toml")],
  [
    "crates/warpforge-protocol/Cargo.toml",
    () => setCargoPackageVersion("crates/warpforge-protocol/Cargo.toml"),
  ],
  [
    "desktop/src-tauri/Cargo.toml",
    () => setCargoPackageVersion("desktop/src-tauri/Cargo.toml"),
  ],
  [
    "desktop/src-tauri/tauri.conf.json",
    () => setJsonVersion("desktop/src-tauri/tauri.conf.json"),
  ],
  ["desktop/package.json", () => setJsonVersion("desktop/package.json")],
  ["Cargo.lock (warpforge)", () => setCargoLockVersion("Cargo.lock", "warpforge")],
  [
    "Cargo.lock (warpforge-protocol)",
    () => setCargoLockVersion("Cargo.lock", "warpforge-protocol"),
  ],
  [
    "desktop/src-tauri/Cargo.lock (warpforge-desktop)",
    () =>
      setCargoLockVersion("desktop/src-tauri/Cargo.lock", "warpforge-desktop"),
  ],
];

for (const [label, apply] of targets) {
  console.log(`${apply() ? "updated" : "unchanged"}: ${label} = ${version}`);
}

console.log(`release metadata synchronized to ${version}`);
