import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailmanError } from "../src/index.js";
import { harness, sleep, task, until } from "./support/harness.js";

/** The rejection is the client's own "closed" error, not a generic failure. */
const closed = (error: unknown): boolean => {
  assert.ok(error instanceof MailmanError, String(error));
  assert.match(error.message, /closed/);
  return true;
};

describe("close() stops everything that is running", { concurrency: true }, () => {
  it("a create sleeping between attempts sends no further POST, so no unwanted task appears", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 400, backoffMaxMs: 800, maxCreateAttempts: 5 } });
    // One refusal: the second POST, if it were sent, would be accepted and would create a task nobody wants.
    api.fail("create", { kind: "status", status: 503, body: { error: "server busy" } });
    const pending = client.createTask(task());
    const rejected = assert.rejects(pending, closed);
    await until(() => api.requests("create").length === 1, 5000, "the first POST");
    client.close(); // now it is asleep in its backoff
    await rejected;
    await sleep(1100); // longer than the whole backoff
    assert.equal(api.requests("create").length, 1, "a POST went out after close()");
    assert.equal(api.created.length, 0, "an unwanted task was created");
  });

  it("run() sleeping on a Retry-After stops too", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "status", status: 503, headers: { "Retry-After": "1" }, body: { error: "server busy" } });
    const rejected = assert.rejects(client.run(task()), closed);
    await until(() => api.requests("create").length === 1, 5000, "the first POST");
    client.close();
    await rejected;
    await sleep(1300);
    assert.equal(api.requests("create").length, 1);
    assert.equal(api.created.length, 0);
  });

  it("verify() sleeping between attempts stops", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { backoffBaseMs: 400, backoffMaxMs: 800 } });
    api.fail("verify", { kind: "status", status: 503 });
    const rejected = assert.rejects(client.verify(), closed);
    await until(() => api.requests("verify").length === 1, 5000, "the first request");
    client.close();
    await rejected;
    await sleep(700);
    assert.equal(api.requests("verify").length, 1, "verify() asked again after close()");
  });

  it("a poll whose body is still arriving is cut: its socket closes, and nothing polls again", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.fail("completed", { kind: "stall" }); // headers and part of the body arrive, then nothing
    const rejected = assert.rejects(client.wait(id, { timeoutMs: 30_000 }), closed);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to start");
    client.close();
    await rejected;
    await until(() => api.requests("completed")[0]!.closedAt !== null, 5000, "the half-read poll's socket to close");
    const polls = api.requests("completed").length;
    await sleep(300);
    assert.equal(api.requests("completed").length, polls, "polled after close()");
    assert.equal(client.stats().pollers, 0);
  });

  it("a poll that never answers is cut: its socket closes", async (t) => {
    const { api, client } = await harness(t);
    const id = await client.createTask(task());
    api.fail("completed", { kind: "hang" });
    const rejected = assert.rejects(client.wait(id, { timeoutMs: 30_000 }), closed);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to start");
    client.close();
    await rejected;
    await until(() => api.requests("completed")[0]!.closedAt !== null, 5000, "the hanging poll's socket to close");
  });

  it("a direct poll() in flight is cut and rejected", async (t) => {
    const { api, client } = await harness(t);
    api.fail("completed", { kind: "hang" });
    const rejected = assert.rejects(client.poll("g"), closed);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to start");
    client.close();
    await rejected;
    await until(() => api.requests("completed")[0]!.closedAt !== null, 5000, "the socket to close");
  });

  it("a poll() queued for its turn at the gate is rejected", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 5000 } });
    await client.poll("g"); // the next poll of this group has to wait five seconds for its turn
    const rejected = assert.rejects(client.poll("g"), closed);
    await sleep(50);
    const closedAt = performance.now();
    client.close();
    await rejected;
    assert.ok(performance.now() - closedAt < 1500, "close() left the queued poll() waiting for its turn");
    assert.equal(api.requests("completed").length, 1);
  });

  it("a create whose POST is in flight is cut: rejected, and its socket closes", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "hang" });
    const rejected = assert.rejects(client.createTask(task()), closed);
    await until(() => api.requests("create").length === 1, 5000, "the POST");
    client.close();
    await rejected;
    await until(() => api.requests("create")[0]!.closedAt !== null, 5000, "the POST's socket to close");
    assert.equal(api.requests("create").length, 1);
  });

  it("every wait in progress is rejected, and the client refuses new work", async (t) => {
    const { api, client } = await harness(t);
    const ids = [await client.createTask(task()), await client.createTask(task()), await client.createTask(task({ group: "other" }))];
    const rejections = ids.map((id) => assert.rejects(client.wait(id, { timeoutMs: 30_000 }), closed));
    await until(() => client.stats().waiters === 3, 5000, "three waiters");
    client.close();
    await Promise.all(rejections);
    assert.deepEqual([client.stats().waiters, client.stats().pollers, client.stats().groups], [0, 0, 0]);
    for (const call of [() => client.createTask(task()), () => client.verify(), () => client.poll(), () => client.wait(ids[0]!), () => client.run(task())]) {
      await assert.rejects(call(), closed);
    }
    const seen = api.seen.length;
    await sleep(200);
    assert.equal(api.seen.length, seen, "a request went out after close()");
  });

  it("closing twice is fine, and closing a client that did nothing sends nothing", async (t) => {
    const { api, client } = await harness(t);
    client.close();
    client.close();
    assert.equal(api.seen.length, 0);
  });

  it("the caller's own signal still works alongside the client's", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "hang" });
    const controller = new AbortController();
    const rejected = assert.rejects(client.createTask(task(), { signal: controller.signal }), /stop it/);
    await until(() => api.requests("create").length === 1, 5000, "the POST");
    controller.abort(new Error("stop it"));
    await rejected;
    await until(() => api.requests("create")[0]!.closedAt !== null, 5000, "the POST's socket to close");
    // The client itself is unaffected.
    assert.equal(await client.verify(), true);
  });
});
