# vite-plugin-jupyterlab

> [!WARNING]
> This project is experimental.

A Vite plugin for building JupyterLab federated extensions.

## Install

```bash
npm install vite-plugin-jupyterlab --save-dev
# or
pnpm add -D vite-plugin-jupyterlab
```

## Usage

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { jupyterlabFederation } from "vite-plugin-jupyterlab";

export default defineConfig({
  plugins: [jupyterlabFederation()],
});
```

Your extension's `package.json` must include a `jupyterlab.outputDir` field:

```json
{
  "name": "my-jupyterlab-extension",
  "jupyterlab": {
    "outputDir": "my_extension/labextension"
  }
}
```

Then build with:

```bash
vite build
```

### Options

| Option  | Type     | Default          | Description                     |
| ------- | -------- | ---------------- | ------------------------------- |
| `entry` | `string` | `"src/index.ts"` | Entry point for the extension.  |

## Development workflow

The package ships a `labext-dev` CLI that symlinks your local build output into the active Python environment's `labextensions` directory. This replaces `jupyter labextension develop --overwrite .` without needing the `jupyter-builder` Python package.

```bash
npx labext-dev
```

## How it works

1. Reads `@jupyterlab/core-meta` to discover which packages JupyterLab shares at runtime
2. Builds the extension as an IIFE, externalizing shared dependencies
3. Generates a `remoteEntry.js` that implements the Module Federation V1 container interface (`get()` / `init()`)
4. Generates the labextension `package.json` for JupyterLab discovery

## License

BSD-3-Clause
