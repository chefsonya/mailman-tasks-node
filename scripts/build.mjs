// Builds dist/esm and dist/cjs (with .d.ts) from src/ using only tsc.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });
for (const [config, type] of [["tsconfig.esm.json", "module"], ["tsconfig.cjs.json", "commonjs"]]) {
  const run = spawnSync(process.execPath, [tsc, "-p", join(root, config)], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
  // The package is "type": "module"; this marker lets the CJS build load as CommonJS.
  const dir = join(root, "dist", type === "module" ? "esm" : "cjs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type })}\n`);
}
