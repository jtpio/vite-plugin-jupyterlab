#!/usr/bin/env node

/**
 * Test script for the create-jupyterlab-extension package.
 *
 * Generates a JupyterLab extension of the given kind, installs dependencies
 * using a local tarball of vite-plugin-jupyterlab, builds the extension with
 * Vite, and verifies that the build output conforms to the JupyterLab
 * labextension structure.
 *
 * Usage:
 *   node tests/test-create-extension.mjs <kind> <tarball-path>
 *
 * Arguments:
 *   kind          One of: frontend, theme, mimerenderer, server
 *   tarball-path  Path to the packed vite-plugin-jupyterlab-*.tgz
 *
 * The generated extension is placed in /tmp/jlab-test-<kind> and is NOT
 * cleaned up so that subsequent CI steps can reference it.
 */

import {
  create,
  toPythonName,
} from "../packages/create-jupyterlab-extension/create.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const KINDS = ["frontend", "theme", "mimerenderer", "server"];

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

const kind = process.argv[2];
const tarballArg = process.argv[3];

if (!kind || !KINDS.includes(kind) || !tarballArg) {
  console.error(
    `Usage: node tests/test-create-extension.mjs <${KINDS.join("|")}> <tarball-path>`,
  );
  process.exit(1);
}

const tarballPath = resolve(tarballArg);
assert(existsSync(tarballPath), `Tarball not found: ${tarballPath}`);

const name = `test-${kind}-extension`;
const pythonName = toPythonName(name);
const testDir = join(tmpdir(), `jlab-test-${kind}`);

console.log(`\n=== Testing "${kind}" extension ===`);
console.log(`  Name:      ${name}`);
console.log(`  Python:    ${pythonName}`);
console.log(`  Directory: ${testDir}`);
console.log(`  Tarball:   ${tarballPath}\n`);

// ---------------------------------------------------------------------------
// 1. Clean and create test directory
// ---------------------------------------------------------------------------

if (existsSync(testDir)) {
  rmSync(testDir, { recursive: true });
}
mkdirSync(testDir, { recursive: true });

// ---------------------------------------------------------------------------
// 2. Generate extension files
// ---------------------------------------------------------------------------

await create(testDir, { name, kind, pkgManager: "pnpm" });
console.log("OK  Extension files generated");

const expectedFiles = [
  "package.json",
  "pyproject.toml",
  "tsconfig.json",
  "vite.config.ts",
  "src/index.ts",
  `${pythonName}/__init__.py`,
];

if (kind === "theme") {
  expectedFiles.push("style/index.css");
}
if (kind === "server") {
  expectedFiles.push(`${pythonName}/routes.py`);
  expectedFiles.push(`jupyter-config/server-config/${pythonName}.json`);
}

for (const f of expectedFiles) {
  assert(existsSync(join(testDir, f)), `Missing generated file: ${f}`);
}
console.log("OK  All expected files present");

// ---------------------------------------------------------------------------
// 3. Patch package.json to use local tarball
// ---------------------------------------------------------------------------

const pkgPath = join(testDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.devDependencies["vite-plugin-jupyterlab"] = tarballPath;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("OK  Patched package.json with local tarball");

// ---------------------------------------------------------------------------
// 4. Install dependencies
// ---------------------------------------------------------------------------

console.log("\n--- Installing dependencies ---");
execSync("pnpm install --no-frozen-lockfile", {
  cwd: testDir,
  stdio: "inherit",
});
console.log("\nOK  Dependencies installed");

// ---------------------------------------------------------------------------
// 5. Build the extension
// ---------------------------------------------------------------------------

console.log("\n--- Building extension ---");
execSync("pnpm build", { cwd: testDir, stdio: "inherit" });
console.log("\nOK  Extension built");

// ---------------------------------------------------------------------------
// 6. Verify build output
// ---------------------------------------------------------------------------

console.log("\n--- Verifying build output ---");

const outputDir = join(testDir, pythonName, "labextension");
const staticDir = join(outputDir, "static");

assert(existsSync(outputDir), `Output directory missing: ${outputDir}`);
assert(existsSync(staticDir), `Static directory missing: ${staticDir}`);

// Check output package.json exists and has _build metadata
const outputPkgPath = join(outputDir, "package.json");
assert(existsSync(outputPkgPath), "Output package.json missing");

const outputPkg = JSON.parse(readFileSync(outputPkgPath, "utf-8"));
assert(
  outputPkg.jupyterlab,
  "Missing jupyterlab field in output package.json",
);
assert(
  outputPkg.jupyterlab._build,
  "Missing jupyterlab._build in output package.json",
);
assert(outputPkg.jupyterlab._build.load, "Missing _build.load");

// Check remoteEntry exists on disk
const remoteEntryRelPath = outputPkg.jupyterlab._build.load;
const remoteEntryPath = join(outputDir, remoteEntryRelPath);
assert(existsSync(remoteEntryPath), `remoteEntry not found: ${remoteEntryRelPath}`);

// Verify remoteEntry content has the Module Federation container API
const remoteEntryContent = readFileSync(remoteEntryPath, "utf-8");
assert(
  remoteEntryContent.includes("_JUPYTERLAB"),
  "remoteEntry missing _JUPYTERLAB global",
);
assert(
  remoteEntryContent.includes(JSON.stringify(name)),
  `remoteEntry missing extension name "${name}"`,
);

// Check extension.js exists in static
const staticFiles = readdirSync(staticDir);
const extensionFile = staticFiles.find(
  (f) => f.startsWith("extension.") && f.endsWith(".js") && f !== "extension.js",
);
assert(extensionFile, "No content-hashed extension.*.js found in static directory");

// Check remoteEntry is also content-hashed
const remoteEntryFile = staticFiles.find(
  (f) => f.startsWith("remoteEntry.") && f.endsWith(".js"),
);
assert(remoteEntryFile, "No content-hashed remoteEntry.*.js found in static directory");

// Kind-specific output checks
if (kind === "mimerenderer") {
  assert(
    outputPkg.jupyterlab._build.mimeExtension === "./mimeExtension",
    "Missing or wrong _build.mimeExtension for mimerenderer kind",
  );
  assert(
    !outputPkg.jupyterlab._build.extension,
    "mimerenderer should not have _build.extension",
  );
} else {
  assert(
    outputPkg.jupyterlab._build.extension === "./extension",
    "Missing or wrong _build.extension",
  );
}

if (kind === "theme") {
  const themesDir = join(outputDir, "themes", name);
  assert(existsSync(themesDir), `Themes directory missing: themes/${name}`);
  assert(
    existsSync(join(themesDir, "index.css")),
    "Theme index.css missing in output",
  );
}

// Verify the Python package structure
assert(
  existsSync(join(testDir, pythonName, "__init__.py")),
  "Python __init__.py missing",
);

const initPy = readFileSync(
  join(testDir, pythonName, "__init__.py"),
  "utf-8",
);
assert(
  initPy.includes("_jupyter_labextension_paths"),
  "__init__.py missing _jupyter_labextension_paths",
);

if (kind === "server") {
  assert(
    initPy.includes("_jupyter_server_extension_points"),
    "__init__.py missing _jupyter_server_extension_points for server kind",
  );
  assert(
    existsSync(join(testDir, pythonName, "routes.py")),
    "Server routes.py missing",
  );
}

// Verify pyproject.toml references the labextension output
const pyproject = readFileSync(join(testDir, "pyproject.toml"), "utf-8");
assert(
  pyproject.includes("labextension"),
  "pyproject.toml missing labextension reference",
);
assert(
  pyproject.includes("hatchling"),
  "pyproject.toml missing hatchling build backend",
);

console.log("OK  Output package.json has valid _build metadata");
console.log(`OK  remoteEntry found: ${remoteEntryRelPath}`);
console.log(`OK  extension found: static/${extensionFile}`);
if (kind === "theme") console.log("OK  Theme CSS output verified");
if (kind === "server") console.log("OK  Server extension structure verified");
console.log("OK  Python package structure verified");

console.log(`\n=== All checks passed for "${kind}" extension ===\n`);
