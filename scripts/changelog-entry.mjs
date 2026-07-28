#!/usr/bin/env node

// Prints the CHANGELOG.md section for one version. The release workflow uses it
// as the GitHub Release body so published notes are exactly the notes that
// Changesets generated from the changesets merged into the release.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tag = process.argv[2];

if (!tag || !/^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  console.error("usage: node scripts/changelog-entry.mjs vX.Y.Z");
  process.exit(2);
}

const version = tag.replace(/^v/, "");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");

// `## X.Y.Z` is the Changesets format; `## [X.Y.Z]` is the hand-written format
// used before Changesets took over versioning.
const heading = new RegExp(
  `^## \\[?${version.replace(/\./g, "\\.")}\\]?\\s*$`,
);
const start = lines.findIndex((line) => heading.test(line));

if (start === -1) {
  console.error(`missing: CHANGELOG.md heading for ${version}`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => /^## /.test(line));
const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();

if (!body) {
  console.error(`empty: CHANGELOG.md section for ${version}`);
  process.exit(1);
}

console.log(body);
