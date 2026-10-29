import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { autoFinish, harness, holdNextPoll, sleep, until } from "./support/harness.js";
import type { MockApi } from "./support/mock-api.js";

const distUrl = new URL("../../dist/esm/index.js", import.meta.url).href;

/** Runs `body` in a fresh Node process against the mock, and returns what it printed and how long it took to exit after printing "done". */
async function runChild(api: MockApi, body: string, clientOptions = ""): Promise<{ stdout: string; exitedAfterMs: number; code: number | null }> {
  const script = `
    import { MailmanTasks } from ${JSON.stringify(distUrl)};
    const client = new MailmanTasks(${JSON.stringify(api.key)}, {
      baseUrl: ${JSON.stringify(api.url)},
      timing: { pollIntervalMs: 40, fullPageIntervalMs: 12, deadlineGraceMs: 60 },
      ${clientOptions}
    });
    const task = (email) => ({
      email,
      mailFilters: [{ target: "from", comparator: "includes", value: "x" }],
      mailElements: [{ name: "code", target: "body", regex: "\\\\d+" }],
    });
    ${body}
    console.log("done");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let doneAt = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk;
    if (!doneAt && stdout.includes("done")) doneAt = performance.now();
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => {
    const killer = setTimeout(() => child.kill(), 8000);
    child.on("exit", (exitCode) => {
      clearTimeout(killer);
      resolve(exitCode);
    });
  });
  const exitedAfterMs = performance.now() - doneAt;
  assert.equal(code, 0, `the child process did not exit cleanly (stderr: ${stderr})`);
  return { stdout, exitedAfterMs, code };
}

describe("an idle client holds nothing open", { concurrency: true }, () => {
  it("a process that has its result can exit: no timer or socket keeps it alive", async (t) => {
    const { api } = await harness(t);
    autoFinish(api, { code: "482913" });
    const { stdout, exitedAfterMs } = await runChild(api, `
      const result = await client.run(task("a@example.com"), { timeoutMs: 5000 });
      console.log(JSON.stringify(result.results));
    `);
    assert.match(stdout, /\{"code":"482913"\}/);
    assert.ok(exitedAfterMs < 2000, `the process lingered ${exitedAfterMs} ms after it was done`);
  });

  it("even with an uncollected result buffered for an hour, and a group still inside its pacing window", async (t) => {
    const { api } = await harness(t);
    autoFinish(api, { code: "1" });
    const { exitedAfterMs } = await runChild(api, `
      const a = await client.createTask(task("a@example.com"));
      const b = await client.createTask(task("b@example.com"));
      await new Promise((resolve) => setTimeout(resolve, 100));   // both are finished on the server
      await client.wait(a, { timeoutMs: 5000 });                   // the same page also buffers b's result
      console.log("buffered:", client.stats().bufferedResults);
    `);
    assert.ok(exitedAfterMs < 2000, `the process lingered ${exitedAfterMs} ms`);
  });

  it("a poll left hanging when its last waiter cancels doesn't keep the process alive", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" });
    const { exitedAfterMs } = await runChild(api, `
      const a = await client.createTask(task("a@example.com"));
      const b = await client.createTask(task("b@example.com"));
      const controller = new AbortController();
      const short = client.wait(a, { timeoutMs: 150 }).catch(() => undefined);
      const long = client.wait(b, { timeoutMs: 3000, signal: controller.signal }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50)); // the poll is in flight, and the server never answers it
      controller.abort(); // the longest waiter goes
      await Promise.all([short, long]);
    `);
    assert.ok(exitedAfterMs < 1500, `the process lingered ${exitedAfterMs} ms`);
  });

  it("a waiter that gives up while the loop waits for its turn lets the process exit at once", async (t) => {
    const { api } = await harness(t);
    // The first poll answers at once; the loop then waits 3 s at the gate for the next one, and the waiter leaves meanwhile.
    const { exitedAfterMs } = await runChild(
      api,
      `
      const a = await client.createTask(task("a@example.com"));
      await client.wait(a, { timeoutMs: 300 }).catch(() => undefined);
    `,
      "timing: { pollIntervalMs: 3000, fullPageIntervalMs: 12, deadlineGraceMs: 60 },",
    );
    assert.ok(exitedAfterMs < 1500, `the process lingered ${exitedAfterMs} ms`);
  });

  it("after a wait that timed out, an abort, and a failed create", async (t) => {
    const { api } = await harness(t);
    api.fail("create", { kind: "status", status: 400, body: { error: "invalid task JSON" } });
    const { exitedAfterMs } = await runChild(api, `
      await client.createTask(task("a@example.com")).catch(() => {});
      const id = await client.createTask(task("b@example.com"));
      await client.wait(id, { timeoutMs: 150 }).catch(() => {});
      const controller = new AbortController();
      const waiting = client.wait(id, { signal: controller.signal }).catch(() => {});
      setTimeout(() => controller.abort(), 50);
      await waiting;
    `);
    assert.ok(exitedAfterMs < 2000, `the process lingered ${exitedAfterMs} ms`);
  });
});

// A poll that was sent is never cut by a deadline or by its last waiter leaving, only by close() (or its own total
// timeout), because the server deletes results as it writes the response. It must not keep a short script alive either.
describe("a poll in flight with nobody waiting", { concurrency: true }, () => {
  it("is left alone when its only waiter gives up, and lets the process exit at once", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" }); // the server never answers
    const { stdout, exitedAfterMs } = await runChild(api, `
      const a = await client.createTask(task("a@example.com"));
      const outcome = await client.wait(a, { timeoutMs: 150 }).then(() => "resolved", (error) => error.constructor.name);
      console.log("wait:", outcome);
      await new Promise((resolve) => setTimeout(resolve, 600)); // well past the deadline: the poll is still in flight
    `);
    assert.match(stdout, /wait: TaskTimeoutError/, "the waiter returns at its deadline");
    // The script ended with the poll in flight and exited at once: the poll's socket and timer don't keep the process alive.
    assert.ok(exitedAfterMs < 1500, `the process lingered ${exitedAfterMs} ms`);
    // The connection stayed open until the process itself went away, not until the waiter's deadline.
    const poll = api.requests("completed")[0]!;
    await until(() => poll.closedAt !== null, 3000, "the child's connection to close");
    assert.ok(poll.closedAt! - poll.at >= 450, `the poll was cut ${(poll.closedAt! - poll.at).toFixed(0)} ms after it was sent, near the waiter's deadline`);
  });

  it("still delivers: what its late answer carries is stored, and a later wait returns it", async (t) => {
    const { api } = await harness(t);
    // b finishes on the server after its waiter-less poll was sent; the poll's answer is held until then.
    api.onCreate = (task) => (String(task.email).startsWith("b@") ? { afterMs: 250, result: { status: "success", results: { code: "late code" } } } : undefined);
    const release = holdNextPoll(api);
    const running = runChild(api, `
      const a = await client.createTask(task("a@example.com"));
      const b = await client.createTask(task("b@example.com"));
      const outcome = await client.wait(a, { timeoutMs: 150 }).then(() => "resolved", (error) => error.constructor.name);
      console.log("a:", outcome);
      await new Promise((resolve) => setTimeout(resolve, 1200)); // the poll in flight answers in the meantime
      console.log("stored:", client.stats().bufferedResults);
      const result = await client.wait(b, { timeoutMs: 1500 }).then((r) => r.results.code, (error) => "lost: " + error.constructor.name);
      console.log("b:", result);
    `);
    await until(() => api.requests("completed").length === 1, 5000, "the child's poll to arrive");
    await sleep(500); // the child's waiter has given up, and b has finished on the server
    release();
    const { stdout } = await running;
    assert.match(stdout, /a: TaskTimeoutError/);
    assert.match(stdout, /stored: 1/, "the late answer was not stored");
    assert.match(stdout, /b: late code/);
    assert.equal(api.requests("completed").length, 1, "the later wait polled again");
  });

  it("a poll() that has to wait behind it keeps the process alive until its turn comes", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" }); // the first request is never answered; its own timeout (500 ms) ends it
    const { stdout } = await runChild(
      api,
      `
      const a = await client.createTask(task("a@example.com"));
      await client.wait(a, { timeoutMs: 150 }).catch(() => undefined); // gives up, the hung poll stays in flight
      const page = await client.poll(); // queued behind it: the process must stay up for that
      console.log("polled:", page.length);
    `,
      "requestTimeoutMs: 500,",
    );
    assert.match(stdout, /polled: 0/);
  });
});
