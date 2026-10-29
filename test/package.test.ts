import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { VERSION } from "../src/index.js";

// dist-test/test/*.js -> the package root is two levels up.
const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Record<string, any>;
const require = createRequire(import.meta.url);

describe("the package", () => {
  it("is mailman-tasks 0.1.0 under the MIT license, and the version in the code matches", () => {
    assert.equal(manifest.name, "mailman-tasks");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.license, "MIT");
    assert.equal(VERSION, manifest.version);
    assert.ok(readFileSync(new URL("LICENSE", root), "utf8").startsWith("MIT License"));
  });

  it("is ready to publish: public, with its repository, issues and homepage, shipping only dist, README and LICENSE", () => {
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.publishConfig?.access, "public");
    assert.equal(manifest.homepage, "https://getmailman.app/developers");
    assert.equal(manifest.repository?.url, "git+https://github.com/chefsonya/mailman-tasks-node.git");
    assert.equal(manifest.bugs?.url, "https://github.com/chefsonya/mailman-tasks-node/issues");
    assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"]);
    assert.match(readFileSync(new URL("LICENSE", root), "utf8"), /^Copyright \(c\) 2026 Mailman$/m);
    assert.match(manifest.scripts.prepublishOnly, /typecheck/);
    assert.match(manifest.scripts.prepublishOnly, /npm test/);
  });

  it("has no runtime dependencies", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(Object.keys(manifest[field] ?? {}), [], field);
    }
    assert.deepEqual(Object.keys(manifest.devDependencies).sort(), ["@types/node", "typescript"]);
  });

  it("declares Node 18 and an exports map with types for both module systems", () => {
    assert.equal(manifest.engines.node, ">=18");
    const exp = manifest.exports["."];
    assert.deepEqual(Object.keys(exp).sort(), ["import", "require"]);
    for (const [kind, entry] of Object.entries(exp as Record<string, { types: string; default: string }>)) {
      for (const file of [entry.types, entry.default]) {
        assert.ok(existsSync(new URL(file, root)), `${kind}: ${file} is missing: run the build first`);
      }
    }
  });

  it("loads as ESM and as CommonJS, by its own name, with the same API", async () => {
    const esm = await import("mailman-tasks");
    const cjs = require("mailman-tasks") as typeof esm;
    for (const lib of [esm, cjs]) {
      assert.equal(typeof lib.MailmanTasks, "function");
      assert.equal(typeof lib.codeTask, "function");
      assert.equal(typeof lib.linkTask, "function");
      assert.equal(lib.VERSION, manifest.version);
    }
    assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
    const names = ["MailmanError", "AuthError", "InvalidRequestError", "PayloadTooLargeError", "RateLimitError", "PendingLimitError", "ServerBusyError", "RequestTimeoutError", "TaskFailedError", "TaskTimeoutError"];
    for (const name of names) assert.ok(name in esm && name in cjs, name);
  });

  it("the built client works end to end", async () => {
    const { MailmanTasks, codeTask } = await import("mailman-tasks");
    const calls: string[] = [];
    const fake: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(calls.length === 1 ? { id: "a".repeat(32), status: "pending" } : { tasks: [{ id: "a".repeat(32), status: "success", results: { code: "123456" } }] }), { status: 200 });
    };
    const client = new MailmanTasks("package-test-key-0123456789abcdefABCDEF", { fetch: fake });
    const result = await client.run(codeTask({ email: "a@b.c", from: "x", subjectIncludes: "y" }), { timeoutMs: 5000 });
    assert.deepEqual(result.results, { code: "123456" });
    assert.deepEqual(calls, ["https://tasks.getmailman.app/api/v1/tasks/mail/create", "https://tasks.getmailman.app/api/v1/tasks/completed?group=default"]);
  });
});
