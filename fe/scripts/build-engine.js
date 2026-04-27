#!/usr/bin/env node
/**
 * Builds the Python worker with PyInstaller using the engine venv.
 * Works on Windows, macOS, and Linux.
 *
 * Usage:
 *   node scripts/build-engine.js
 *   node scripts/build-engine.js --spec worker.release.spec
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const feDir = resolve(fileURLToPath(import.meta.url), "../..");
const engineDir = join(feDir, "..", "engine");
const specArgIndex = process.argv.indexOf("--spec");
const specName =
  specArgIndex >= 0 && process.argv[specArgIndex + 1]
    ? process.argv[specArgIndex + 1]
    : process.env.BLURITOUT_WORKER_SPEC || "worker.spec";
const specPath = join(engineDir, specName);

const pythonCandidates =
  process.platform === "win32"
    ? [join(engineDir, ".venv", "Scripts", "python.exe")]
    : [
        join(engineDir, ".venv", "bin", "python3"),
        join(engineDir, ".venv", "bin", "python"),
      ];

const python = pythonCandidates.find((p) => existsSync(p));
if (!python) {
  console.error(
    `Could not find venv Python in engine/.venv — run the venv setup first.\nSearched:\n${pythonCandidates.join("\n")}`,
  );
  process.exit(1);
}

if (!existsSync(specPath)) {
  console.error(`Could not find PyInstaller spec: ${specPath}`);
  process.exit(1);
}

console.log(`Using Python: ${python}`);
console.log(`Using PyInstaller spec: ${specName}`);
execFileSync(python, ["-m", "PyInstaller", specName, "--noconfirm"], {
  cwd: engineDir,
  stdio: "inherit",
});
