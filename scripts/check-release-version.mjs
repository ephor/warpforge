#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tag = process.argv[2];

if (!tag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  console.error("usage: node scripts/check-release-version.mjs vX.Y.Z");
  process.exit(2);
}

const expected = tag.slice(1);

function json(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function cargoMetadata(manifestPath) {
  const output = execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--locked",
      "--manifest-path",
      resolve(root, manifestPath),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

const rootMetadata = cargoMetadata("Cargo.toml");
const desktopMetadata = cargoMetadata("desktop/src-tauri/Cargo.toml");
const desktopPackage = json("desktop/package.json");
const desktopLock = json("desktop/package-lock.json");
const tauriConfig = json("desktop/src-tauri/tauri.conf.json");
const updaterPublicKey =
  process.env.TAURI_UPDATER_PUBLIC_KEY?.trim() ||
  tauriConfig.plugins?.updater?.pubkey?.trim();

function cargoVersion(metadata, name) {
  const pkg = metadata.packages.find((candidate) => candidate.name === name);
  if (!pkg) throw new Error(`Cargo package not found: ${name}`);
  return pkg.version;
}

const versions = new Map([
  ["Cargo.toml (warpforge)", cargoVersion(rootMetadata, "warpforge")],
  [
    "crates/warpforge-protocol/Cargo.toml",
    cargoVersion(rootMetadata, "warpforge-protocol"),
  ],
  [
    "desktop/src-tauri/Cargo.toml",
    cargoVersion(desktopMetadata, "warpforge-desktop"),
  ],
  ["desktop/src-tauri/tauri.conf.json", tauriConfig.version],
  ["desktop/package.json", desktopPackage.version],
  ["desktop/package-lock.json", desktopLock.version],
  ["desktop/package-lock.json packages[\"\"]", desktopLock.packages?.[""]?.version],
]);

let valid = true;
for (const [source, version] of versions) {
  const matches = version === expected;
  console.log(`${matches ? "ok" : "mismatch"}: ${source} = ${String(version)}`);
  valid &&= matches;
}

const releaseConfiguration = [
  ["Tauri bundling is enabled", tauriConfig.bundle?.active === true],
  [
    "Tauri updater artifacts are enabled",
    tauriConfig.bundle?.createUpdaterArtifacts === true,
  ],
  [
    "the warpforge daemon is bundled as a sidecar",
    tauriConfig.bundle?.externalBin?.includes("binaries/warpforge") === true,
  ],
  [
    "the updater public key is configured (build environment or Tauri config)",
    typeof updaterPublicKey === "string" && updaterPublicKey.length > 0,
  ],
  [
    "the stable GitHub Releases updater endpoint is configured",
    tauriConfig.plugins?.updater?.endpoints?.includes(
      "https://github.com/ephor/warpforge/releases/latest/download/latest.json",
    ) === true,
  ],
  [
    "the frontend updater dependency is locked",
    typeof desktopLock.packages?.[""]?.dependencies?.["@tauri-apps/plugin-updater"] ===
      "string",
  ],
];

for (const [requirement, matches] of releaseConfiguration) {
  console.log(`${matches ? "ok" : "missing"}: ${requirement}`);
  valid &&= matches;
}

let changelog;
try {
  changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
} catch {
  console.error("missing: CHANGELOG.md");
  valid = false;
}

const escapedVersion = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const changelogMatches = changelog
  ? [...changelog.matchAll(new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, "gm"))]
  : [];

if (changelog && changelogMatches.length !== 1) {
  console.error(
    `${changelogMatches.length === 0 ? "missing" : "duplicate"}: ` +
      `CHANGELOG.md heading \"## [${expected}]\"`,
  );
  valid = false;
}

if (!valid) {
  console.error(`release metadata is not ready for ${tag}`);
  process.exit(1);
}

console.log(`release metadata is consistent for ${tag}`);
