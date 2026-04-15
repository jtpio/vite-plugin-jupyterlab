import type { Plugin } from "vite";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  lstatSync,
  copyFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve, join, dirname, isAbsolute, relative } from "node:path";
import { createRequire } from "node:module";

export interface JupyterLabFederationOptions {
  /** Entry point for the extension. Defaults to "src/index.ts". */
  entry?: string;
}

interface ExtensionMetadata {
  extension: string | undefined;
  mimeExtension: string | undefined;
  schemaDir: string | undefined;
  themePath: string | undefined;
}

/**
 * Normalize extension metadata from package.json.
 * Matches the behavior of Build.normalizeExtension() in @jupyter/builder.
 *
 * - `extension: true` / `mimeExtension: true` → resolved to the package main
 * - string values are kept as-is
 * - extension and mimeExtension must not point to the same export
 */
function normalizeExtension(pkg: Record<string, any>): ExtensionMetadata {
  const { jupyterlab, main = "index.js", name } = pkg;
  if (!jupyterlab) {
    throw new Error(`Package ${name} does not contain JupyterLab metadata.`);
  }

  let { extension, mimeExtension, schemaDir, themePath } = jupyterlab;

  extension = extension === true ? main : extension;
  mimeExtension = mimeExtension === true ? main : mimeExtension;

  if (extension && mimeExtension && extension === mimeExtension) {
    throw new Error("extension and mimeExtension cannot be the same export.");
  }

  return { extension, mimeExtension, schemaDir, themePath };
}

/**
 * Compute a short content hash for cache busting.
 */
function shortHash(content: string | Buffer): string {
  return createHash("md5").update(content).digest("hex").slice(0, 8);
}

/**
 * Recursively copy a directory's contents.
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Empty a directory's contents without removing the directory itself
 * (preserves symlinks to the directory).
 */
function emptyDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true });
  }
}

/**
 * Read core.package.json from @jupyterlab/core-meta to determine which
 * packages JupyterLab shares at runtime.
 *
 * Returns the set of package names that are available in JupyterLab's
 * Module Federation shared scope (i.e., dependencies + resolutions from
 * the core JupyterLab build).
 */
function getCoreSharedPackages(): Set<string> {
  const require = createRequire(import.meta.url);
  const coreMetaPkgPath = require.resolve(
    "@jupyterlab/core-meta/package.json",
  );
  const coreDataPath = join(dirname(coreMetaPkgPath), "core.package.json");
  const coreData = JSON.parse(readFileSync(coreDataPath, "utf-8"));

  // Same logic as @jupyter/builder: shared packages are the union of
  // core dependencies and resolutions
  const coreDeps: Record<string, string> = {
    ...coreData.dependencies,
    ...(coreData.resolutions ?? {}),
  };

  return new Set(Object.keys(coreDeps));
}

/**
 * Vite plugin that produces a webpack Module Federation V1 compatible
 * output for JupyterLab federated extensions.
 *
 * JupyterLab loads extensions via <script> tags and expects
 * window._JUPYTERLAB[name] with .get()/.init() methods.
 *
 * This plugin:
 * 1. Reads @jupyterlab/core-meta to discover which packages JupyterLab
 *    shares at runtime — only those are externalized
 * 2. Builds the extension as an IIFE with shared deps mapped to globals
 * 3. Generates a remoteEntry.js that resolves shared modules from the
 *    MF V1 shared scope (via init()) and loads the IIFE (via get())
 * 4. Copies schema files for extension settings
 * 5. Processes theme CSS via a secondary Vite build
 * 6. Generates a style module that injects extension CSS
 * 7. Generates the labextension package.json for JupyterLab discovery
 */
export function jupyterlabFederation(
  options?: JupyterLabFederationOptions,
): Plugin {
  const cwd = process.cwd();
  const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf-8"));
  const outputDir: string = pkg.jupyterlab?.outputDir;

  if (!outputDir) {
    throw new Error(
      'vite-plugin-jupyterlab: missing "jupyterlab.outputDir" in package.json',
    );
  }

  // Guard against dangerous outputDir values that could cause emptyDir
  // to delete the project root or files outside the project.
  const resolvedOutputDir = resolve(cwd, outputDir);
  const relativeOutputDir = relative(cwd, resolvedOutputDir);
  if (
    !relativeOutputDir ||
    relativeOutputDir.startsWith("..") ||
    isAbsolute(relativeOutputDir)
  ) {
    throw new Error(
      `vite-plugin-jupyterlab: "jupyterlab.outputDir" must be a subdirectory ` +
        `of the project root. Got: ${JSON.stringify(outputDir)}`,
    );
  }

  const labMeta = normalizeExtension(pkg);

  // Determine which extension dependencies are shared by JupyterLab
  // (externalized) vs private to the extension (bundled).
  const coreShared = getCoreSharedPackages();
  const extDeps = Object.keys(pkg.dependencies || {});
  const sharedDeps = extDeps.filter((dep) => coreShared.has(dep));

  // Map each shared dependency to a unique global variable name
  const sharedGlobals: Record<string, string> = {};
  for (const dep of sharedDeps) {
    sharedGlobals[dep] = `__jl_shared_${dep.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  // Global variable name for the extension's IIFE exports
  const extensionGlobal = `__jl_ext_${pkg.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  // Whether the extension exposes a style module (guard with typeof per
  // @jupyter/builder: only treat string values as style paths)
  const hasStyle =
    typeof pkg.styleModule === "string" || typeof pkg.style === "string";

  let root = cwd;

  return {
    name: "jupyterlab-federation",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      // Clean the output directory before building, matching
      // @jupyter/builder's fs.emptyDirSync(outputPath).
      // Use emptyDir (not rmSync) to preserve symlinks to the directory.
      const absOutputDir = resolve(root, outputDir);
      emptyDir(absOutputDir);
    },
    config() {
      return {
        define: {
          "process.env.NODE_ENV": JSON.stringify("production"),
        },
        build: {
          lib: {
            entry: options?.entry ?? "src/index.ts",
            formats: ["iife"],
            name: extensionGlobal,
            fileName: () => "extension.js",
          },
          outDir: join(outputDir, "static"),
          target: "es2022",
          emptyOutDir: true,
          rollupOptions: {
            external: sharedDeps,
            output: {
              globals: sharedGlobals,
              // Shim require() inside the IIFE so bundled CJS modules
              // (e.g. react/jsx-runtime) can resolve externalized packages.
              intro: `var require = function(mod) { return globalThis["__jl_shared_" + mod.replace(/[^a-zA-Z0-9_]/g, "_")]; };`,
            },
          },
        },
      };
    },
    async closeBundle() {
      const absOutputDir = resolve(root, outputDir);
      const staticDir = join(absOutputDir, "static");
      mkdirSync(staticDir, { recursive: true });

      // --- 1. Content-hash extension.js ---
      const extPath = join(staticDir, "extension.js");
      const extContent = readFileSync(extPath);
      const extHash = shortHash(extContent);
      const hashedExtName = `extension.${extHash}.js`;
      renameSync(extPath, join(staticDir, hashedExtName));

      // --- 2. Copy schema files ---
      if (labMeta.schemaDir) {
        const schemaSource = resolve(root, labMeta.schemaDir);
        const schemaDest = join(absOutputDir, "schemas", pkg.name);

        // Match @jupyter/builder: remove the schema directory when the
        // stored version equals the current version (forces a clean
        // re-copy during development). On version mismatch the directory
        // is kept and new files are copied on top. If package.json.orig
        // is missing or unreadable, the catch branch removes everything.
        if (existsSync(schemaDest)) {
          try {
            const origPkg = JSON.parse(
              readFileSync(join(schemaDest, "package.json.orig"), "utf-8"),
            );
            if (origPkg.version === pkg.version) {
              rmSync(schemaDest, { recursive: true });
            }
          } catch {
            rmSync(schemaDest, { recursive: true });
          }
        }

        mkdirSync(schemaDest, { recursive: true });

        // Recursive copy handles subdirectories inside schemaDir
        copyDirRecursive(schemaSource, schemaDest);

        // Write package.json.orig for future version comparison
        copyFileSync(
          resolve(root, "package.json"),
          join(schemaDest, "package.json.orig"),
        );
      }

      // --- 3. Process theme CSS ---
      if (labMeta.themePath) {
        const themeDir = join(absOutputDir, "themes", pkg.name);
        const themeEntry = resolve(root, labMeta.themePath);

        const { build: viteBuild } = await import("vite");

        // Create a temp JS entry that imports the theme CSS so Vite
        // processes @import, url() references, and asset inlining.
        const tmpDir = join(absOutputDir, ".vite-tmp");
        mkdirSync(tmpDir, { recursive: true });
        const tmpEntry = join(tmpDir, "theme-entry.js");
        writeFileSync(tmpEntry, `import ${JSON.stringify(themeEntry)};\n`);

        try {
          await viteBuild({
            root,
            configFile: false,
            logLevel: "warn",
            build: {
              outDir: themeDir,
              emptyOutDir: true,
              rollupOptions: {
                input: tmpEntry,
                output: {
                  assetFileNames: (assetInfo: any) => {
                    const name =
                      assetInfo.names?.[0] ?? assetInfo.name ?? "";
                    if (name.endsWith(".css")) return "index.css";
                    return "[name]-[hash][extname]";
                  },
                  entryFileNames: "_theme-entry.js",
                },
              },
              cssMinify: true,
            },
          });

          // Remove the throwaway JS entry from output
          const entryJs = join(themeDir, "_theme-entry.js");
          if (existsSync(entryJs)) rmSync(entryJs);
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // --- 4. Process style module ---
      let hashedStyleName: string | undefined;
      if (hasStyle) {
        const styleRef =
          typeof pkg.styleModule === "string"
            ? pkg.styleModule
            : (pkg.style as string);
        const stylePath = resolve(root, styleRef);

        const { build: viteBuild } = await import("vite");

        // Create a temp JS entry to import the CSS
        const tmpDir = join(absOutputDir, ".vite-tmp");
        mkdirSync(tmpDir, { recursive: true });
        const tmpEntry = join(tmpDir, "style-entry.js");
        writeFileSync(tmpEntry, `import ${JSON.stringify(stylePath)};\n`);

        try {
          const result = await viteBuild({
            root,
            configFile: false,
            logLevel: "warn",
            build: {
              write: false,
              rollupOptions: {
                input: tmpEntry,
              },
              // Inline assets so url() references work when injected
              // via a <style> element (no base URL for relative paths).
              assetsInlineLimit: 100000,
              cssMinify: true,
            },
          });

          // Extract the CSS content from the build result
          const output = Array.isArray(result)
            ? result[0].output
            : (result as any).output;

          let cssContent = "";
          for (const chunk of output) {
            if (
              chunk.type === "asset" &&
              typeof chunk.fileName === "string" &&
              chunk.fileName.endsWith(".css")
            ) {
              cssContent =
                typeof chunk.source === "string"
                  ? chunk.source
                  : Buffer.from(chunk.source).toString("utf-8");
              break;
            }
          }

          if (cssContent) {
            // Generate a JS module that injects the CSS into the document.
            // This is loaded by remoteEntry.js when get('./style') is called.
            const styleJs = `(function() {\n  var s = document.createElement('style');\n  s.textContent = ${JSON.stringify(cssContent)};\n  document.head.appendChild(s);\n})();\n`;
            const styleHash = shortHash(styleJs);
            hashedStyleName = `style.${styleHash}.js`;
            writeFileSync(join(staticDir, hashedStyleName), styleJs);
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // --- 5. Generate remoteEntry.js ---
      const modules: Record<
        string,
        { file: string; type: "extension" | "style" }
      > = {};
      if (labMeta.extension) {
        modules["./extension"] = { file: hashedExtName, type: "extension" };
      }
      if (labMeta.mimeExtension) {
        modules["./mimeExtension"] = {
          file: hashedExtName,
          type: "extension",
        };
      }
      if (hashedStyleName) {
        modules["./style"] = { file: hashedStyleName, type: "style" };
      }

      // MF V1 container loaded by JupyterLab via <script> tag.
      // init() resolves shared modules from the MF shared scope and
      // assigns them to globals so the IIFE can reference them.
      // get() loads the IIFE via a <script> tag and returns the module.
      const remoteEntry = `\
(function() {
  var _JUPYTERLAB = globalThis._JUPYTERLAB = globalThis._JUPYTERLAB || {};
  var base = document.currentScript
    ? document.currentScript.src.replace(/\\/[^/]*$/, '/')
    : '';
  var sharedGlobals = ${JSON.stringify(sharedGlobals)};
  var extensionGlobal = ${JSON.stringify(extensionGlobal)};
  var modules = ${JSON.stringify(modules)};

  var scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = base + src;
        script.onload = resolve;
        script.onerror = function() {
          reject(new Error('Failed to load ' + src));
        };
        document.head.appendChild(script);
      });
    }
    return scriptCache[src];
  }

  var extensionModule = null;

  _JUPYTERLAB[${JSON.stringify(pkg.name)}] = {
    get: function(module) {
      var info = modules[module];
      if (!info) {
        throw new Error(
          'Module ' + module + ' does not exist in container ' +
          ${JSON.stringify(pkg.name)}
        );
      }

      if (info.type === 'extension') {
        return loadScript(info.file).then(function() {
          if (!extensionModule) {
            extensionModule = globalThis[extensionGlobal];
            delete globalThis[extensionGlobal];
          }
          var mod = extensionModule;
          return function() {
            return mod && mod.__esModule
              ? mod
              : { __esModule: true, default: mod };
          };
        });
      }

      if (info.type === 'style') {
        return loadScript(info.file).then(function() {
          return function() { return { __esModule: true }; };
        });
      }
    },
    init: function(shareScope) {
      var promises = [];
      Object.keys(sharedGlobals).forEach(function(pkgName) {
        var globalName = sharedGlobals[pkgName];
        if (shareScope[pkgName]) {
          var versions = shareScope[pkgName];
          var version = Object.keys(versions)[0];
          if (version && versions[version].get) {
            promises.push(
              versions[version].get().then(function(factory) {
                globalThis[globalName] = factory();
              })
            );
          }
        }
      });
      return Promise.all(promises);
    }
  };
})();
`;
      const remoteEntryHash = shortHash(remoteEntry);
      const hashedRemoteEntry = `remoteEntry.${remoteEntryHash}.js`;
      writeFileSync(join(staticDir, hashedRemoteEntry), remoteEntry);

      // --- 6. Write full package.json with _build metadata ---
      const outputPkg = JSON.parse(
        readFileSync(resolve(root, "package.json"), "utf-8"),
      );
      const buildMeta: Record<string, string> = {
        load: `static/${hashedRemoteEntry}`,
      };
      if (labMeta.extension) {
        buildMeta.extension = "./extension";
      }
      if (labMeta.mimeExtension) {
        buildMeta.mimeExtension = "./mimeExtension";
      }
      if (hashedStyleName) {
        buildMeta.style = "./style";
      }
      outputPkg.jupyterlab._build = buildMeta;
      writeFileSync(
        join(absOutputDir, "package.json"),
        JSON.stringify(outputPkg, null, 2) + "\n",
      );
    },
  };
}

/**
 * Create a symlink from the active Python environment's labextensions
 * directory to the local labextension build output.
 *
 * This replaces `jupyter labextension develop --overwrite .` without
 * needing the jupyter-builder Python package.
 */
export function develop(): void {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const name: string = pkg.name;
  const src = resolve(root, pkg.jupyterlab.outputDir);

  // Get the active Python environment's sys.prefix
  const sysPrefix = execSync('python -c "import sys; print(sys.prefix)"', {
    encoding: "utf-8",
  }).trim();

  const labextDir = join(sysPrefix, "share", "jupyter", "labextensions");
  const dest = join(labextDir, name);

  // Ensure labextensions directory exists
  mkdirSync(labextDir, { recursive: true });

  // Remove existing destination if present
  try {
    if (lstatSync(dest)) {
      console.log(`Removing: ${dest}`);
      rmSync(dest, { recursive: true });
    }
  } catch {
    // Does not exist, nothing to remove
  }

  // Create symlink
  console.log(`Symlinking: ${dest} -> ${src}`);
  symlinkSync(src, dest);
  console.log("Done.");
}
