import type { Plugin } from "vite";
import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";

export interface JupyterLabFederationOptions {
  /** Entry point for the extension. Defaults to "src/index.ts". */
  entry?: string;
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
 * 4. Generates the labextension package.json for JupyterLab discovery
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

  let root = cwd;

  return {
    name: "jupyterlab-federation",
    configResolved(config) {
      root = config.root;
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
    closeBundle() {
      const absOutputDir = resolve(root, outputDir);
      mkdirSync(join(absOutputDir, "static"), { recursive: true });

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
  _JUPYTERLAB[${JSON.stringify(pkg.name)}] = {
    get: function(module) {
      if (module === './extension') {
        return new Promise(function(resolve, reject) {
          var script = document.createElement('script');
          script.src = base + 'extension.js';
          script.onload = function() {
            var mod = globalThis[extensionGlobal];
            delete globalThis[extensionGlobal];
            resolve(function() {
              return mod && mod.__esModule ? mod : { __esModule: true, default: mod };
            });
          };
          script.onerror = function() {
            reject(new Error('Failed to load extension ' + ${JSON.stringify(pkg.name)}));
          };
          document.head.appendChild(script);
        });
      }
      throw new Error('Module ' + module + ' does not exist in container ' + ${JSON.stringify(pkg.name)});
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
      writeFileSync(join(absOutputDir, "static", "remoteEntry.js"), remoteEntry);

      // labextension package.json for JupyterLab discovery
      writeFileSync(
        join(absOutputDir, "package.json"),
        JSON.stringify(
          {
            name: pkg.name,
            version: pkg.version,
            jupyterlab: {
              _build: {
                load: "static/remoteEntry.js",
                extension: "./extension",
              },
            },
          },
          null,
          2,
        ),
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
