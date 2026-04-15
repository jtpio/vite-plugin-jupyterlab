import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function jsonDumps(obj) {
  return JSON.stringify(obj, null, 2);
}

function stringLiteral(value) {
  return JSON.stringify(value);
}

/**
 * Convert an extension name to a valid Python package name.
 * Strips @scope/ prefix, converts camelCase, and replaces non-alphanumeric
 * chars with underscores.
 */
export function toPythonName(name) {
  let n = String(name).trim();
  if (n.startsWith("@")) {
    n = n.split("/")[1] ?? "";
  } else if (n.includes("/")) {
    n = n.split("/").pop() ?? "";
  }

  n = n
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (!n) return "jupyterlab_extension";
  if (/^\d/.test(n)) return `jupyterlab_${n}`;
  return n;
}

function toPythonProjectName(name) {
  return toPythonName(name).replace(/_/g, "-");
}

function scriptCommand(pkgManager, script) {
  if (pkgManager === "npm" || pkgManager === "cnpm") {
    return `${pkgManager} run ${script}`;
  }
  if (pkgManager === "bun") {
    return `bun run ${script}`;
  }
  return `${pkgManager} ${script}`;
}

/**
 * Read the current version of vite-plugin-jupyterlab from the sibling
 * package so generated projects always reference the correct version.
 */
async function getPluginVersion() {
  let candidates = [
    path.join(
      __dirname,
      "..",
      "vite-plugin-jupyterlab",
      "package.json",
    ),
    path.join(
      __dirname,
      "node_modules",
      "vite-plugin-jupyterlab",
      "package.json",
    ),
  ];

  for (let pkgPath of candidates) {
    try {
      let pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      return `^${pkg.version}`;
    } catch {
      // Try the next package layout.
    }
  }

  return "^0.1.1";
}

// ---------------------------------------------------------------------------
// Template functions
// ---------------------------------------------------------------------------

function packageJson(
  name,
  { kind, description, pluginVersion, pythonName, pkgManager },
) {
  let deps = {};
  let jupyterlab = {};

  if (kind === "mimerenderer") {
    deps = {
      "@jupyterlab/rendermime-interfaces": "^3.0.0",
      "@lumino/widgets": "^2.0.0",
    };
    jupyterlab = {
      mimeExtension: true,
      outputDir: `${pythonName}/labextension`,
    };
  } else if (kind === "theme") {
    deps = {
      "@jupyterlab/application": "^4.0.0",
      "@jupyterlab/apputils": "^4.0.0",
    };
    jupyterlab = {
      extension: true,
      themePath: "style/index.css",
      outputDir: `${pythonName}/labextension`,
    };
  } else if (kind === "server") {
    deps = {
      "@jupyterlab/application": "^4.0.0",
      "@jupyterlab/coreutils": "^6.0.0",
      "@jupyterlab/services": "^7.0.0",
    };
    jupyterlab = {
      extension: true,
      outputDir: `${pythonName}/labextension`,
    };
  } else {
    deps = {
      "@jupyterlab/application": "^4.0.0",
    };
    jupyterlab = {
      extension: true,
      outputDir: `${pythonName}/labextension`,
    };
  }

  let buildCmd = scriptCommand(pkgManager, "build");

  return jsonDumps({
    name,
    version: "0.1.0",
    description,
    scripts: {
      build: "vp build",
      "dev:install": `${buildCmd} && uv pip install -e . && labext-dev`,
    },
    dependencies: deps,
    devDependencies: {
      typescript: "^6.0.0",
      vite: "npm:@voidzero-dev/vite-plus-core@latest",
      "vite-plugin-jupyterlab": pluginVersion,
      "vite-plus": "latest",
    },
    pnpm: {
      overrides: {
        vite: "npm:@voidzero-dev/vite-plus-core@latest",
      },
      ignoredBuiltDependencies: ["@fortawesome/fontawesome-free"],
      peerDependencyRules: {
        allowAny: ["vite"],
      },
    },
    jupyterlab,
  });
}

function pyprojectToml(name, { kind, description, pythonName, pythonProjectName }) {
  let deps = '["jupyterlab>=4.0.0"]';
  if (kind === "server") {
    deps = '["jupyterlab>=4.0.0", "jupyter-server>=2.4.0"]';
  }

  let sharedData = `\
"${pythonName}/labextension" = ${stringLiteral(`share/jupyter/labextensions/${name}`)}
`;
  if (kind === "server") {
    sharedData += `"jupyter-config/server-config/${pythonName}.json" = "etc/jupyter/jupyter_server_config.d/${pythonName}.json"
`;
  }

  return `\
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = ${stringLiteral(pythonProjectName)}
version = "0.1.0"
description = ${stringLiteral(description)}
requires-python = ">=3.10"
dependencies = ${deps}

[tool.hatch.build]
artifacts = ["${pythonName}/labextension"]

[tool.hatch.build.targets.wheel.shared-data]
${sharedData}`;
}

function tsconfigJson() {
  return jsonDumps({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src"],
  });
}

function viteConfigTs() {
  return `\
import { defineConfig } from "vite";
import { jupyterlabFederation } from "vite-plugin-jupyterlab";

export default defineConfig({
  plugins: [jupyterlabFederation()],
});
`;
}

function indexTsFrontend(name, description) {
  return `\
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";

const plugin: JupyterFrontEndPlugin<void> = {
  id: ${stringLiteral(`${name}:plugin`)},
  description: ${stringLiteral(description)},
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    console.log(${stringLiteral(`${name} activated!`)});
  },
};

export default plugin;
`;
}

function indexTsMimerenderer(name, description) {
  return `\
import type { IRenderMime } from "@jupyterlab/rendermime-interfaces";
import { Widget } from "@lumino/widgets";

class OutputWidget extends Widget implements IRenderMime.IRenderer {
  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this._mimeType = options.mimeType;
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const data = model.data[this._mimeType] as string;
    this.node.textContent = data;
  }

  private _mimeType: string;
}

const rendererFactory: IRenderMime.IRendererFactory = {
  safe: true,
  mimeTypes: ["text/plain"],
  createRenderer: (options) => new OutputWidget(options),
};

const extension: IRenderMime.IExtension = {
  id: ${stringLiteral(`${name}:plugin`)},
  rendererFactory,
  rank: 100,
  dataType: "string",
};

export default extension;
`;
}

function indexTsTheme(name, description) {
  return `\
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import { IThemeManager } from "@jupyterlab/apputils";

const plugin: JupyterFrontEndPlugin<void> = {
  id: ${stringLiteral(`${name}:plugin`)},
  description: ${stringLiteral(description)},
  autoStart: true,
  requires: [IThemeManager],
  activate: (app: JupyterFrontEnd, manager: IThemeManager) => {
    const style = ${stringLiteral(`${name}/index.css`)};
    manager.register({
      name: ${stringLiteral(name)},
      isLight: true,
      themeScrollbars: false,
      load: () => manager.loadCSS(style),
      unload: () => Promise.resolve(),
    });
  },
};

export default plugin;
`;
}

function indexTsServer(name, description, pythonName) {
  return `\
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import { URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";

const plugin: JupyterFrontEndPlugin<void> = {
  id: ${stringLiteral(`${name}:plugin`)},
  description: ${stringLiteral(description)},
  autoStart: true,
  activate: async (app: JupyterFrontEnd) => {
    const settings = ServerConnection.makeSettings();
    const url = URLExt.join(settings.baseUrl, ${stringLiteral(pythonName)}, "hello");
    try {
      const response = await ServerConnection.makeRequest(url, {}, settings);
      const data = await response.json();
      console.log(${stringLiteral(`${name}:`)}, data);
    } catch (error) {
      console.error(${stringLiteral(`${name}: failed to fetch`)}, error);
    }
  },
};

export default plugin;
`;
}

function indexTs(name, { kind, description, pythonName }) {
  switch (kind) {
    case "mimerenderer":
      return indexTsMimerenderer(name, description);
    case "theme":
      return indexTsTheme(name, description);
    case "server":
      return indexTsServer(name, description, pythonName);
    default:
      return indexTsFrontend(name, description);
  }
}

function initPy(name, { kind, description, pythonName }) {
  if (kind === "server") {
    return `\
"""${description}"""

__version__ = "0.1.0"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": ${stringLiteral(name)}}]


def _jupyter_server_extension_points():
    return [{"module": ${stringLiteral(pythonName)}}]


def _load_jupyter_server_extension(server_app):
    from .routes import setup_handlers

    setup_handlers(server_app.web_app)
    server_app.log.info(${stringLiteral(`${name} server extension loaded.`)})
`;
  }

  return `\
"""${description}"""

__version__ = "0.1.0"


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": ${stringLiteral(name)}}]
`;
}

function routesPy(name, pythonName) {
  return `\
"""Server routes."""

import json

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado


class HelloRouteHandler(APIHandler):
    @tornado.web.authenticated
    def get(self):
        self.finish(json.dumps({"data": ${stringLiteral(`Hello from ${name}!`)}}))


def setup_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    route_pattern = url_path_join(base_url, ${stringLiteral(pythonName)}, "hello")
    handlers = [(route_pattern, HelloRouteHandler)]
    web_app.add_handlers(host_pattern, handlers)
`;
}

function serverConfigJson(pythonName) {
  return jsonDumps({
    ServerApp: {
      jpserver_extensions: {
        [pythonName]: true,
      },
    },
  });
}

function themeIndexCss() {
  return `\
/*
  Theme CSS variables.
  See https://jupyterlab.readthedocs.io/en/latest/extension/extension_dev.html#theme-extension
  for a list of available CSS variables.
*/

:root {
  --jp-layout-color0: #ffffff;
  --jp-layout-color1: #f5f5f5;
  --jp-layout-color2: #eeeeee;
}
`;
}

function gitignore(pythonName) {
  return `\
node_modules/
${pythonName}/labextension/
*.egg-info/
dist/
.vite/
.venv/
.__mf__temp/
__pycache__/
`;
}

function readme(name, { kind, description, pkgManager }) {
  let devInstallCmd = scriptCommand(pkgManager, "dev:install");

  let body = `\
# ${name}

${description}

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- A JavaScript package manager (pnpm, npm, yarn, or Bun)
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

## Development

\`\`\`bash
# Install JS dependencies
${pkgManager} install

# Build the extension, install in dev mode, and symlink
${devInstallCmd}

# Start JupyterLab
jupyter lab
\`\`\`

## Project Structure

\`\`\`
${name}/
├── src/
│   └── index.ts          # Extension entry point
├── ${toPythonName(name)}/
│   └── __init__.py       # Python package
├── package.json          # JS dependencies and build config
├── pyproject.toml        # Python packaging
├── tsconfig.json         # TypeScript config
└── vite.config.ts        # Vite config (uses vite-plugin-jupyterlab)
\`\`\`
`;

  return body;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function gatherFiles({ name, kind, pkgManager }) {
  let pythonName = toPythonName(name);
  let pythonProjectName = toPythonProjectName(name);
  let description = `A JupyterLab extension.`;
  let pluginVersion = await getPluginVersion();

  let opts = {
    kind,
    description,
    pythonName,
    pythonProjectName,
    pluginVersion,
    pkgManager,
  };

  let files = [
    { path: "package.json", content: packageJson(name, opts) },
    { path: "pyproject.toml", content: pyprojectToml(name, opts) },
    { path: "tsconfig.json", content: tsconfigJson() },
    { path: "vite.config.ts", content: viteConfigTs() },
    { path: "src/index.ts", content: indexTs(name, opts) },
    { path: `${pythonName}/__init__.py`, content: initPy(name, opts) },
    { path: ".gitignore", content: gitignore(pythonName) },
    { path: "README.md", content: readme(name, opts) },
  ];

  if (kind === "theme") {
    files.push({ path: "style/index.css", content: themeIndexCss() });
  }

  if (kind === "server") {
    files.push({
      path: `${pythonName}/routes.py`,
      content: routesPy(name, pythonName),
    });
    files.push({
      path: `jupyter-config/server-config/${pythonName}.json`,
      content: serverConfigJson(pythonName),
    });
  }

  return files;
}

export async function create(target, options) {
  const files = await gatherFiles(options);
  const promises = files.map(async (file) => {
    let location = path.resolve(target, file.path);
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(location, file.content, "utf-8");
  });
  await Promise.all(promises);
  return files.map((f) => f.path);
}
