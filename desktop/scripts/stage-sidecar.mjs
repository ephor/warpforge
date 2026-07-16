import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const profile = valueAfter("--profile") ?? "release";
const explicitTarget = valueAfter("--target");
const noTarget = args.includes("--no-target");

const command = (program, commandArgs) => {
  const result = spawnSync(program, commandArgs, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
};

const host = command("rustc", ["-vV"])
  .split("\n")
  .find((line) => line.startsWith("host: "))
  ?.slice(6);
const target =
  explicitTarget ??
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  process.env.CARGO_BUILD_TARGET ??
  process.env.npm_config_target ??
  host;

if (!target) {
  throw new Error("Unable to determine the Tauri target triple; pass --target explicitly");
}
if (noTarget && explicitTarget) {
  throw new Error("--no-target and --target cannot be used together");
}

const root = resolve(import.meta.dirname, "../..");
const cargoArgs = ["build", "--manifest-path", resolve(root, "Cargo.toml")];
if (profile === "release") cargoArgs.push("--release");
if (!noTarget) cargoArgs.push("--target", target);
command("cargo", cargoArgs);

const exe = target.includes("windows") ? "warpforge.exe" : "warpforge";
const source = noTarget
  ? resolve(root, "target", profile, exe)
  : resolve(root, "target", target, profile, exe);
const suffix = target.includes("windows") ? ".exe" : "";
const destination = resolve(
  root,
  "desktop/src-tauri/binaries",
  `warpforge-${target}${suffix}`,
);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Staged ${source} -> ${destination}`);
