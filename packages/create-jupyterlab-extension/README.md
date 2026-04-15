# create-jupyterlab-extension

Scaffold a JupyterLab extension powered by Vite and [`vite-plugin-jupyterlab`](../vite-plugin-jupyterlab/).

## Usage

```bash
pnpm create jupyterlab-extension my-extension
# or
npm create jupyterlab-extension my-extension
# or
npx create-jupyterlab-extension my-extension
```

The CLI prompts for one of four extension kinds:

| Kind | Description |
| --- | --- |
| Frontend | A standard JupyterLab frontend extension |
| Theme | A JupyterLab theme extension with custom CSS |
| MIME Renderer | Renders a custom MIME type in notebook outputs |
| Frontend + Server | Frontend extension with a Python server endpoint |

## What Gets Generated

```
my-extension/
├── src/
│   └── index.ts          # Extension entry point
├── my_extension/
│   └── __init__.py       # Python package with labextension paths
├── package.json          # JS dependencies and build config
├── pyproject.toml        # Python packaging (hatchling)
├── tsconfig.json         # TypeScript config
├── vite.config.ts        # Vite config with vite-plugin-jupyterlab
└── .gitignore
```

Server extensions additionally include route handlers and Jupyter server configuration.

## Getting Started

After scaffolding:

```bash
cd my-extension
pnpm install
pnpm dev:install
jupyter lab
```

## License

BSD-3-Clause
