// Builds the package, compiles the tests, and runs every compiled test file with node:test.
//   node scripts/test.mjs [--no-build] [name-filter...]
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const filters = args.filter((a) => !a.startsWith("--"));

// A hung test must fail the run, not hang CI: every step has a time limit.
const step = (label, file, fileArgs, timeout = 120_000) => {
  const run = spawnSync(process.execPath, [file, ...fileArgs], { cwd: root, stdio: "inherit", timeout });
  if (run.status !== 0) {
    console.error(run.error ? `${label} did not finish: ${run.error.message}` : `${label} failed`);
    process.exit(run.status ?? 1);
  }
};

if (!noBuild) step("build", join(root, "scripts", "build.mjs"), []);
rmSync(join(root, "dist-test"), { recursive: true, force: true });
step("test compile", tsc, ["-p", join(root, "tsconfig.test.json")]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".test.js") && (!filters.length || filters.some((f) => path.includes(f)))) files.push(path);
  }
};
walk(join(root, "dist-test", "test"));
files.sort();
if (!files.length) {
  console.error("no test files found");
  process.exit(1);
}
step("tests", "--test", files, 300_000);
