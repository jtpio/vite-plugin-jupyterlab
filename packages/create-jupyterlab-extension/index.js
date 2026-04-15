#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as process from "node:process";

import * as _p from "@clack/prompts";
import { bold, cyan, grey } from "kleur/colors";

import { create } from "./create.js";

let p = new Proxy(_p, {
  get(target, prop) {
    if (prop === "select" || prop === "text" || prop === "confirm") {
      let fn = target[prop];
      return async (opts) => {
        let { value } = await target.group({
          value: () => fn(opts),
        });
        return value;
      };
    }
    return Reflect.get(target, prop);
  },
});

function detectPackageManager() {
  if (globalThis.Bun) return "bun";
  const userAgent = process.env.npm_config_user_agent;
  if (!userAgent) return;

  const match = userAgent.match(/^([^/\s]+)\//);
  if (!match) return;

  const name = match[1] === "npminstall" ? "cnpm" : match[1];
  const knownPackageManagers = new Set(["npm", "pnpm", "yarn", "bun", "cnpm"]);
  return knownPackageManagers.has(name) ? name : undefined;
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

let pkg = JSON.parse(
  fs.readFileSync(new URL("package.json", import.meta.url), "utf-8"),
);

let cwd = process.argv[2] || ".";

console.clear();
console.log(`
${grey(`create-jupyterlab-extension version ${pkg.version}`)}
`);

p.intro("Create a JupyterLab extension");

if (cwd === ".") {
  let dir = await p.text({
    message: "Where should we create your extension?",
    placeholder: "  (hit Enter to use current directory)",
  });
  if (p.isCancel(dir)) {
    process.exit(1);
  }
  if (dir) {
    cwd = dir;
  }
}

if (fs.existsSync(cwd) && fs.readdirSync(cwd).length > 0) {
  let force = await p.confirm({
    message: "Directory not empty. Continue?",
    initialValue: false,
  });
  if (force !== true) {
    process.exit(1);
  }
}

let kind = await p.select({
  message: "What kind of extension?",
  options: [
    {
      label: "Frontend",
      hint: "A standard JupyterLab frontend extension.",
      value: "frontend",
    },
    {
      label: "Theme",
      hint: "A JupyterLab theme extension with custom CSS.",
      value: "theme",
    },
    {
      label: "MIME Renderer",
      hint: "Renders a custom MIME type in notebook outputs.",
      value: "mimerenderer",
    },
    {
      label: "Frontend + Server",
      hint: "Frontend extension with a Python server endpoint.",
      value: "server",
    },
  ],
});

if (p.isCancel(kind)) {
  process.exit(1);
}

let pkgManager = detectPackageManager() ?? "pnpm";

let name = path.basename(path.resolve(cwd));

await create(cwd, { name, kind, pkgManager }).catch((err) => {
  console.error("Error writing files:", err);
  process.exit(1);
});

p.outro("Your extension is ready!");

console.log("\nNext steps:");
let i = 1;

const relative = path.relative(process.cwd(), cwd);
if (relative !== "") {
  console.log(`  ${i++}: ${bold(cyan(`cd ${relative}`))}`);
}

console.log(`  ${i++}: ${bold(cyan(`${pkgManager} install`))}`);
console.log(
  `  ${i++}: ${bold(cyan(scriptCommand(pkgManager, "dev:install")))}`,
);
console.log(
  `  ${i++}: ${bold(cyan("jupyter lab"))}`,
);

console.log(
  `\n${grey("See the README.md for more details.")}`,
);
