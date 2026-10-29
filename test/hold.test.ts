import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Held, nodeHttp, type HttpCall } from "../src/http.js";
import { makeRedactor } from "../src/redact.js";
import { Transport } from "../src/transport.js";
import { harness, sleep, task, until } from "./support/harness.js";
import { KEY } from "./support/mock-api.js";

/** How many handles of this kind are keeping the event loop alive right now. Unreferenced ones aren't listed. */
const alive = (kind: "TCPSocketWrap" | "Timeout"): number => process.getActiveResourcesInfo().filter((name) => name === kind).length;

// A poll in flight keeps the process alive only while somebody waits for it. When nobody does, its socket and its
// timeout timer are unreferenced, so a short script exits instead of waiting for a response nobody asked for.
describe("what keeps the process alive while a poll is in flight", () => {
  it("a held request's socket keeps the process alive; letting go of the hold stops that, taking it back starts it again", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" });
    const hold = new Held();
    const controller = new AbortController();
    const pending = nodeHttp(`${api.url}/api/v1/tasks/completed`, {
      method: "GET",
      headers: {},
      signal: controller.signal,
      redirect: "manual",
      hold,
    }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the request to arrive");
    await sleep(30);
    const held = alive("TCPSocketWrap");
    hold.set(false);
    assert.equal(alive("TCPSocketWrap"), held - 1, "an unheld request's socket still keeps the process alive");
    hold.set(true);
    assert.equal(alive("TCPSocketWrap"), held, "a held request's socket doesn't keep the process alive");
    hold.set(false);
    controller.abort();
    await pending;
  });

  it("a request that starts unheld never keeps the process alive", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" });
    const hold = new Held(false);
    const controller = new AbortController();
    const pending = nodeHttp(api.url + "/api/v1/tasks/completed", {
      method: "GET",
      headers: {},
      signal: controller.signal,
      redirect: "manual",
      hold,
    }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the request to arrive");
    await sleep(30);
    // Taking the hold is what makes the client's end of the connection count: it wasn't counting before.
    const unheld = alive("TCPSocketWrap");
    hold.set(true);
    assert.equal(alive("TCPSocketWrap"), unheld + 1, "the socket was keeping the process alive before anybody held it");
    hold.set(false);
    controller.abort();
    await pending;
  });

  it("a request without a hold keeps the process alive, as a call somebody awaits should", async (t) => {
    const { api } = await harness(t);
    api.fail("completed", { kind: "hang" });
    const controller = new AbortController();
    const pending = nodeHttp(`${api.url}/api/v1/tasks/completed`, { method: "GET", headers: {}, signal: controller.signal, redirect: "manual" }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the request to arrive");
    await sleep(30);
    const sockets = alive("TCPSocketWrap");
    assert.ok(sockets >= 2, `${sockets} sockets are keeping the process alive (the request's two ends)`);
    controller.abort();
    await pending;
  });

  it("the timer of a held request keeps the process alive; letting go of the hold stops that, taking it back starts it again", async () => {
    const hung: HttpCall = () => new Promise(() => undefined);
    const transport = new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call: hung, redact: makeRedactor(KEY) });
    const hold = new Held();
    const controller = new AbortController();
    const before = alive("Timeout");
    const pending = transport.exchange({ method: "GET", path: "/x", timeoutMs: 30_000, signal: controller.signal, hold }).catch(() => undefined);
    assert.equal(alive("Timeout"), before + 1, "the request has no timer, or one that isn't keeping the process alive");
    hold.set(false);
    assert.equal(alive("Timeout"), before, "an unheld request's timer still keeps the process alive");
    hold.set(true);
    assert.equal(alive("Timeout"), before + 1, "a held request's timer doesn't keep the process alive");
    hold.set(false);
    controller.abort();
    await pending;
  });

  it("a request that is over has taken its watcher away (a long-lived hold doesn't collect one per poll)", async (t) => {
    const { api } = await harness(t);
    const hold = new Held();
    const answer = await nodeHttp(`${api.url}/api/v1/user/verify`, {
      method: "GET",
      headers: { Authorization: `Token ${KEY}` },
      signal: new AbortController().signal,
      redirect: "manual",
      hold,
    });
    assert.equal(answer.status, 200);
    assert.equal(hold.watching, 0, "an answered request is still watching the hold");

    api.fail("completed", { kind: "hang" });
    const controller = new AbortController();
    const pending = nodeHttp(`${api.url}/api/v1/tasks/completed`, { method: "GET", headers: {}, signal: controller.signal, redirect: "manual", hold }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the request to arrive");
    assert.equal(hold.watching, 1, "a request in flight isn't watching the hold");
    controller.abort();
    await pending;
    assert.equal(hold.watching, 0, "an aborted request is still watching the hold");

    const answered: HttpCall = async () => ({ status: 200, text: async () => "{}" });
    const transport = new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call: answered, redact: makeRedactor(KEY) });
    await transport.exchange({ method: "GET", path: "/x", timeoutMs: 1000, hold });
    assert.equal(hold.watching, 0, "a finished exchange is still watching the hold");
  });

  it("the transport hands the hold to the call, and only when it has one", async () => {
    const inits: Array<Record<string, unknown>> = [];
    const call: HttpCall = async (_url, init) => (inits.push({ ...init }), { status: 200, text: async () => "{}" });
    const transport = new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call, redact: makeRedactor(KEY) });
    const hold = new Held();
    await transport.exchange({ method: "GET", path: "/x", timeoutMs: 1000, hold });
    await transport.exchange({ method: "GET", path: "/x", timeoutMs: 1000 });
    assert.equal(inits[0]!.hold, hold, "the call didn't get the hold");
    assert.equal("hold" in inits[1]!, false, "a request without a hold carries a hold property");
  });

  it("the timer of a request that starts unheld never keeps the process alive", async () => {
    const hung: HttpCall = () => new Promise(() => undefined);
    const transport = new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call: hung, redact: makeRedactor(KEY) });
    const hold = new Held(false);
    const controller = new AbortController();
    const before = alive("Timeout");
    const pending = transport.exchange({ method: "GET", path: "/x", timeoutMs: 30_000, signal: controller.signal, hold }).catch(() => undefined);
    assert.equal(alive("Timeout"), before, "a request that started unheld has a timer that keeps the process alive");
    hold.set(true);
    assert.equal(alive("Timeout"), before + 1);
    hold.set(false);
    controller.abort();
    await pending;
  });

  it("the client holds the process for a poll in flight exactly while somebody waits for it", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 15_000 });
    const [a, b] = [await client.createTask(task()), await client.createTask(task())];
    await until(() => api.requests("create").every((seen) => seen.closedAt !== null), 5000, "the creates' connections to close");
    api.fail("completed", { kind: "hang" });
    const firstWait = client.wait(a, { timeoutMs: 400 }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");
    await sleep(30);
    const whileWaiting = alive("TCPSocketWrap");

    await firstWait; // the only waiter gives up; the poll stays in flight, and nobody needs the process for it
    assert.equal(alive("TCPSocketWrap"), whileWaiting - 1, "a poll nobody waits for still keeps the process alive");

    const secondWait = client.wait(b, { timeoutMs: 400 }).catch(() => undefined); // somebody waits for it again
    assert.equal(alive("TCPSocketWrap"), whileWaiting, "a poll somebody waits for doesn't keep the process alive");

    await secondWait;
    assert.equal(alive("TCPSocketWrap"), whileWaiting - 1, "a poll nobody waits for any more still keeps the process alive");
  });

  it("a poll() that is waiting for its turn holds the process for the request in flight, like a waiter", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ requestTimeoutMs: 15_000 });
    const a = await client.createTask(task());
    await until(() => api.requests("create").every((seen) => seen.closedAt !== null), 5000, "the create's connection to close");
    api.fail("completed", { kind: "hang" });
    const firstWait = client.wait(a, { timeoutMs: 300 }).catch(() => undefined);
    await until(() => api.requests("completed").length === 1, 5000, "the poll to be sent");
    await sleep(30);
    const whileWaiting = alive("TCPSocketWrap");
    await firstWait;
    assert.equal(alive("TCPSocketWrap"), whileWaiting - 1, "a poll nobody waits for still keeps the process alive");

    const controller = new AbortController();
    const polling = client.poll(undefined, { signal: controller.signal }).catch(() => undefined); // queued behind the request in flight
    assert.equal(alive("TCPSocketWrap"), whileWaiting, "a poll() that waits for its turn doesn't hold the process");

    controller.abort();
    await polling;
    assert.equal(alive("TCPSocketWrap"), whileWaiting - 1, "a poll() that went away still holds the process");
  });
});
