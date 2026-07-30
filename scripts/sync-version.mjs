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

// Every crate versioned in lockstep with the product. Each one has to be
// rewritten in each lockfile that mentions it.
const LOCAL_CRATES = ["warpforge", "warpforge-desktop", "warpforge-protocol"];

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

// Rewrites the `version` of every locally versioned `[[package]]` entry in a
// Cargo lockfile. A crate can appear in more than one lockfile: the desktop
// shell depends on warpforge-protocol by path, so that lockfile carries the
// protocol version too, and `cargo check --locked` rejects a stale copy.
function setCargoLockVersions(path) {
  const contents = read(path);
  let updated = contents;
  let patched = 0;

  for (const name of LOCAL_CRATES) {
    const pattern = new RegExp(
      `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]*(")`,
    );
    if (!pattern.test(updated)) continue;
    updated = updated.replace(pattern, `$1${version}$2`);
    patched += 1;
  }

  if (patched === 0) {
    console.error(`missing: ${path} has no entry for any local crate`);
    process.exit(1);
  }
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
  ["Cargo.lock", () => setCargoLockVersions("Cargo.lock")],
  [
    "desktop/src-tauri/Cargo.lock",
    () => setCargoLockVersions("desktop/src-tauri/Cargo.lock"),
  ],
];

for (const [label, apply] of targets) {
  console.log(`${apply() ? "updated" : "unchanged"}: ${label} = ${version}`);
}

console.log(`release metadata synchronized to ${version}`);
