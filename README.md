# vite-plugin-jupyterlab

> [!WARNING]
> This project is experimental.

Build JupyterLab extensions with [Vite](https://vite.dev) instead of webpack.

This monorepo contains two packages:

| Package | Description |
| --- | --- |
| [vite-plugin-jupyterlab](./packages/vite-plugin-jupyterlab/) | Vite plugin that produces Module Federation V1 compatible output for JupyterLab |
| [create-jupyterlab-extension](./packages/create-jupyterlab-extension/) | Scaffolding CLI to generate new extension projects |

## Quick Start

Create a new JupyterLab extension:

```bash
pnpm create jupyterlab-extension my-extension
cd my-extension
pnpm install
pnpm dev:install
jupyter lab
```

Or add the plugin to an existing project:

```bash
pnpm add -D vite-plugin-jupyterlab
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { jupyterlabFederation } from "vite-plugin-jupyterlab";

export default defineConfig({
  plugins: [jupyterlabFederation()],
});
```

## How It Works

The Vite plugin replaces `@jupyter/builder` (the webpack-based build tool) for JupyterLab federated extensions. It:

1. Reads `@jupyterlab/core-meta` to discover which packages JupyterLab shares at runtime and externalizes only those
2. Builds the extension as an IIFE with shared dependencies mapped to globals
3. Generates a `remoteEntry.js` implementing the Module Federation V1 container interface (`get()` / `init()`)
4. Copies schema files, processes theme CSS, and generates style injection modules
5. Writes the labextension `package.json` for JupyterLab discovery

A `labext-dev` CLI is also included to symlink build output into the active Python environment, replacing `jupyter labextension develop --overwrite .`.

## Development

```bash
pnpm install
pnpm build
```

## License

BSD-3-Clause
