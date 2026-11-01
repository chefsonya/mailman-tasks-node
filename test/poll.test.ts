import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthError,
  InvalidRequestError,
  MailmanError,
  NetworkError,
  RateLimitError,
  ServerBusyError,
} from "../src/index.js";
import { gaps, harness, task, TOLERANCE, until } from "./support/harness.js";

const pad = (n: number) => n.toString(16).padStart(32, "0");
// Ids of other people's tasks. The mock numbers its own tasks from 1, so these stay clear of them.
const foreignId = (n: number) => (0x1000 + n).toString(16).padStart(32, "0");
const ok = (code: string) => ({ status: "success" as const, results: { code } });

describe("poll", { concurrency: true }, () => {
  it("is destructive and pages by 100, oldest first", async (t) => {
    const { api, client } = await harness(t);
    for (let i = 0; i < 250; i++) api.push("g", { id: pad(i), status: "success", results: { code: String(i) } });

    const pages = [await client.poll("g"), await client.poll("g"), await client.poll("g"), await client.poll("g")];
    assert.deepEqual(pages.map((page) => page.length), [100, 100, 50, 0]);
    assert.deepEqual(pages[0]!.map((r) => r.id), Array.from({ length: 100 }, (_, i) => pad(i)));
    assert.equal(pages[2]![49]!.id, pad(249));
    assert.equal(api.waiting("g"), 0, "the server kept nothing");
    assert.equal(api.requests("completed").length, 4);
    // Only the group asked for is touched.
    assert.ok(api.requests("completed").every((seen) => seen.group === "g"));
  });

  it("gives a success without results an empty results object in poll, wait and a repeat wait", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.finish(id, { status: "success" });
    assert.deepEqual(await client.poll(), [{ id, status: "success", results: {} }]);
    assert.deepEqual(await client.wait(id), { id, status: "success", results: {} });
    assert.deepEqual(await client.wait(id), { id, status: "success", results: {} });
  });

  it("answers {tasks: []} as an empty list, and a second poll returns nothing (M7)", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.finish(id, ok("1"));
    assert.equal((await client.poll()).length, 1);
    assert.deepEqual(await client.poll(), []);
  });

  it("polls the client's group by default", async (t) => {
    const { api, make } = await harness(t);
    await make({ group: "signup-bot" }).poll();
    assert.equal(api.requests("completed")[0]!.group, "signup-bot");
  });

  it("URL-encodes the group (M13)", async (t) => {
    const { api, client } = await harness(t);
    const group = "a b&c=d/é+?#%";
    api.push(group, { id: pad(1), status: "success", results: { code: "1" } });
    assert.equal((await client.poll(group)).length, 1);
    const [seen] = api.requests("completed");
    assert.equal(seen!.url, `/api/v1/tasks/completed?group=${encodeURIComponent(group)}`);
    assert.equal(seen!.group, group, "the server decodes exactly what was given");
    for (const encoded of ["%20", "%26", "%3D", "%2F", "%C3%A9", "%2B", "%3F", "%23", "%25"]) assert.ok(seen!.url.includes(encoded), encoded);
  });

  it("leaves the group out for the empty group", async (t) => {
    const { api, client } = await harness(t);
    await client.poll("");
    const [seen] = api.requests("completed");
    assert.equal(seen!.url, "/api/v1/tasks/completed");
    assert.equal(seen!.group, null);
  });

  it("refuses a group that isn't text, before sending", async (t) => {
    const { api, client } = await harness(t);
    await assert.rejects(client.poll(5 as unknown as string), InvalidRequestError);
    await assert.rejects(client.poll("x".repeat(1025)), InvalidRequestError);
    await assert.rejects(client.poll("\uD800"), InvalidRequestError);
    assert.equal(api.seen.length, 0);
  });

  it("sends the key only in the Authorization header", async (t) => {
    const { api, client } = await harness(t);
    await client.poll();
    const [seen] = api.requests("completed");
    assert.equal(seen!.headers.authorization, `Token ${api.key}`);
    assert.equal(seen!.headers["user-agent"], "mailman-tasks-node/0.2.0");
    assert.ok(!seen!.url.includes(api.key));
  });
});

describe("poll hands what it gets to the client's store", { concurrency: true }, () => {
  it("a later wait(id) resolves from the buffer without another request", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.finish(id, ok("482913"));
    const polled = await client.poll();
    assert.deepEqual(polled, [{ id, status: "success", results: { code: "482913" } }]);
    assert.equal(client.stats().retainedResults, 1, "poll() handed it out, and the client keeps a readable copy");
    const result = await client.wait(id);
    assert.deepEqual(result, polled[0]);
    assert.equal(api.requests("completed").length, 1, "wait() polled again instead of using the stored result");
    assert.equal(client.stats().retainedResults, 1);
  });

  it("a wait that is already running gets a result that a direct poll received", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    // The direct poll is in flight (the server holds it) when the waiter arrives and the task completes.
    api.fail("completed", { kind: "delay", ms: 200 });
    const direct = client.poll();
    await until(() => api.requests("completed").length === 1);
    const waiting = client.wait(id);
    api.finish(id, ok("777777"));
    const [polled, result] = await Promise.all([direct, waiting]);
    assert.equal(polled.length, 1, "the caller of poll() still gets it");
    assert.equal(result.results?.code, "777777", "and so does the waiter");
    assert.equal(api.requests("completed").length, 1, "one request served both");
  });

  it("results of tasks this client didn't create are stored too, and the ones nobody takes are bounded", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxUnclaimedResults: 5 } });
    const mine = await client.createTask(task({ group: "g" }));
    const waiting = client.wait(mine, { timeoutMs: 5000 }); // keeps the loop polling group g
    // Eight results of somebody else's tasks turn up in the group the loop is polling.
    for (let i = 0; i < 8; i++) api.push("g", { id: foreignId(i), status: "success", results: { code: String(i) } });
    // Wait for the client's own state, not the server's: the queue empties when the answer is sent, not when it is read.
    await until(() => client.stats().bufferedResults > 0, 3000, "the loop to store them");
    assert.equal(client.stats().bufferedResults, 5, "the three oldest went");
    // The newest are kept, for whoever asks.
    assert.equal((await client.wait(foreignId(7), { group: "g", timeoutMs: 100 })).results?.code, "7");
    await assert.rejects(client.wait(foreignId(0), { group: "g", timeoutMs: 100 }), /lost/);
    api.finish(mine, ok("x"));
    await waiting;
  });

  it("everything a direct poll() returns stays readable by wait(id), not only what the unclaimed bound keeps", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ limits: { maxUnclaimedResults: 5 } });
    for (let i = 0; i < 8; i++) api.push("g", { id: pad(i), status: "success", results: { code: String(i) } });
    assert.equal((await client.poll("g")).length, 8, "the caller gets all of them");
    assert.equal(client.stats().retainedResults, 8);
    for (let i = 0; i < 8; i++) assert.equal((await client.wait(pad(i), { group: "g", timeoutMs: 100 })).results?.code, String(i));
  });
});

describe("poll: one attempt, errors typed, nothing retried inside", { concurrency: true }, () => {
  it("maps the answers of the API to its error classes", async (t) => {
    const { api, client } = await harness(t);
    api.fail("completed", { kind: "status", status: 401, body: { error: "invalid user API key" } });
    await assert.rejects(client.poll(), AuthError);
    api.fail("completed", { kind: "status", status: 429, headers: { "Retry-After": "7" }, body: { error: "rate limit exceeded" } });
    await assert.rejects(client.poll(), (error: unknown) => error instanceof RateLimitError && error.retryAfter === 7);
    api.fail("completed", { kind: "status", status: 503, body: { error: "server shutting down" } });
    await assert.rejects(client.poll(), ServerBusyError);
    api.fail("completed", { kind: "status", status: 400, body: { error: "invalid group query" } });
    await assert.rejects(client.poll(), InvalidRequestError);
    api.fail("completed", { kind: "status", status: 404 });
    await assert.rejects(client.poll(), (error: unknown) => error instanceof MailmanError && error.status === 404);
    api.fail("completed", { kind: "drop" });
    await assert.rejects(client.poll(), NetworkError);
    assert.equal(api.requests("completed").length, 6, "each call made exactly one request");
  });

  it("an unreadable 200 is an error, not an empty page", async (t) => {
    const { api, client } = await harness(t);
    api.fail("completed", { kind: "status", status: 200, body: "<html>captive portal</html>" });
    await assert.rejects(client.poll(), /not JSON/);
    api.fail("completed", { kind: "status", status: 200, body: { nope: true } });
    await assert.rejects(client.poll(), /without a task list/);
  });

  it("calls made together are paced one after another by the group's gate", async (t) => {
    const { api, client } = await harness(t);
    await Promise.all([client.poll(), client.poll(), client.poll()]);
    const times = api.times("completed");
    assert.equal(times.length, 3);
    for (const gap of gaps(times)) assert.ok(gap >= 40 - TOLERANCE, `polls only ${gap} ms apart`);
  });

  it("a full page is followed sooner than an ordinary one", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 400, fullPageIntervalMs: 20 } });
    for (let i = 0; i < 150; i++) api.push("g", { id: pad(i), status: "success", results: { code: "x" } });
    await client.poll("g"); // 100: more is waiting
    await client.poll("g"); // 50
    await client.poll("g"); // 0
    const [afterFull, afterPage] = gaps(api.times("completed"));
    assert.ok(afterFull! >= 20 - TOLERANCE && afterFull! < 350, `after a full page: ${afterFull}`);
    assert.ok(afterPage! >= 400 - TOLERANCE, `after a short page: ${afterPage}`);
  });
});
