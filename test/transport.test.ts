import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  AuthError,
  InvalidRequestError,
  MailmanError,
  MailmanTasks,
  NetworkError,
  TaskFailedError,
  TaskTimeoutError,
} from "../src/index.js";
import type { HttpCall } from "../src/http.js";
import { makeRedactor } from "../src/redact.js";
import { Transport } from "../src/transport.js";
import { FAST, gaps, harness, sleep, task, TOLERANCE } from "./support/harness.js";
import { KEY } from "./support/mock-api.js";

const ok = (code: string) => ({ status: "success" as const, results: { code } });

describe("nothing hidden between the client and the wire", { concurrency: true }, () => {
  it("a poll that gets a 421 makes exactly one wire attempt: nothing re-sends it outside the gate", async (t) => {
    const { api, client } = await harness(t);
    const misdirected = { kind: "status", status: 421 } as const;
    api.fail("completed", misdirected, misdirected, misdirected);
    await assert.rejects(client.poll("g"), (error: unknown) => error instanceof MailmanError && error.status === 421);
    // Node's global fetch re-sends a 421 once, on a fresh connection, about a millisecond later and outside any pacing.
    await sleep(150);
    assert.equal(api.requests("completed").length, 1, "one poll() made more than one request");
  });

  it("a loop that gets 421s repeats only through the gate: one request per attempt, spaced by the pacing", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ timing: { pollIntervalMs: 80 } });
    const id = await client.createTask(task());
    const misdirected = { kind: "status", status: 421 } as const;
    api.fail("completed", misdirected, misdirected);
    api.finish(id, ok("after the 421s"));
    assert.equal((await client.wait(id, { timeoutMs: 5000 })).results?.code, "after the 421s");
    const polls = api.requests("completed");
    assert.equal(polls.length, 3, "two refused attempts and the one that worked: no wire attempt of its own");
    for (const gap of gaps(polls.map((p) => p.at))) assert.ok(gap >= 80 - TOLERANCE, `two requests only ${gap.toFixed(2)} ms apart`);
  });

  it("a create that gets a 421 makes exactly one POST and is never replayed", async (t) => {
    const { api, client } = await harness(t);
    const misdirected = { kind: "status", status: 421 } as const;
    api.fail("create", misdirected, misdirected, misdirected);
    await assert.rejects(client.createTask(task()), (error: unknown) => error instanceof MailmanError && error.status === 421);
    await sleep(150);
    assert.equal(api.requests("create").length, 1, "the POST was sent more than once");
    assert.equal(api.created.length, 0);
  });

  it("a connection reset is one failed attempt, not two: GET and POST", async (t) => {
    const { api, client } = await harness(t);
    api.fail("completed", { kind: "drop" });
    await assert.rejects(client.poll("g"), NetworkError);
    api.fail("create", { kind: "drop" });
    await assert.rejects(client.createTask(task()), NetworkError);
    await sleep(150);
    assert.equal(api.requests("completed").length, 1, "the GET was re-sent");
    assert.equal(api.requests("create").length, 1, "the POST was re-sent");
  });

  it("every request has a connection of its own, so no stale keep-alive socket can reset one", async (t) => {
    const { api, client } = await harness(t);
    await client.poll("g");
    await client.poll("g");
    await client.createTask(task());
    await client.verify();
    assert.deepEqual(api.seen.map((s) => s.served), [1, 1, 1, 1], "a connection carried more than one request");
    assert.equal(new Set(api.seen.map((s) => s.socket)).size, 4);
    for (const seen of api.seen) assert.equal(seen.headers.connection, "close");
  });

  it("does not follow redirects: a followed 307 would send the POST twice", async (t) => {
    const { api, client } = await harness(t);
    api.fail("create", { kind: "status", status: 307, headers: { Location: "/api/v1/tasks/mail/create" } });
    await assert.rejects(client.createTask(task()), (error: unknown) => {
      assert.ok(error instanceof MailmanError);
      assert.equal(error.status, 307);
      assert.match(error.message, /redirect.*baseUrl/);
      return true;
    });
    assert.equal(api.seen.length, 1, "the redirect target was requested");
    api.fail("completed", { kind: "status", status: 301, headers: { Location: "https://elsewhere.example/" } });
    await assert.rejects(client.poll(), (error: unknown) => error instanceof MailmanError && error.status === 301);
    assert.equal(api.requests("completed").length, 1);
  });

  it("sends exactly the headers the API wants", async (t) => {
    const { api, client } = await harness(t);
    await client.verify();
    const { headers } = api.requests("verify")[0]!;
    assert.equal(headers.authorization, `Token ${api.key}`, "the word Token, a space, the key (M1)");
    assert.equal(headers["user-agent"], "mailman-tasks-node/0.2.0");
    assert.equal(headers.accept, "application/json");
  });

  it("takes a custom User-Agent", async (t) => {
    const { api, make } = await harness(t);
    await make({ userAgent: "my-bot/2.1 (+https://example.com)" }).verify();
    assert.equal(api.requests("verify")[0]!.headers["user-agent"], "my-bot/2.1 (+https://example.com)");
  });

  it("uses the injected fetch, with the options that keep it honest", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("{}", { status: 200 });
    };
    const client = new MailmanTasks(KEY, { fetch: fake });
    assert.equal(await client.verify(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://tasks.getmailman.app/api/v1/user/verify");
    assert.equal(calls[0]!.init.redirect, "manual");
    assert.ok(calls[0]!.init.signal, "every request carries a signal for its timeout");
    assert.deepEqual(calls[0]!.init.headers, {
      Authorization: `Token ${KEY}`,
      "User-Agent": "mailman-tasks-node/0.2.0",
      Accept: "application/json",
    });
  });
});

describe("what ends a request", { concurrency: true }, () => {
  const hung: HttpCall = () => new Promise(() => undefined);
  const transport = () => new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call: hung, redact: makeRedactor(KEY) });

  it("a cap ends it at the cap (a create is abandoned at its deadline)", async () => {
    const started = performance.now();
    const cap = started + 120;
    const error = await transport().exchange({ method: "POST", path: "/x", timeoutMs: 30_000, capAt: () => cap }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NetworkError && error.timedOut, String(error));
    assert.ok(performance.now() - started >= 120 - TOLERANCE && performance.now() - started < 2500);
  });

  it("a request whose cap has already passed ends at once, and sends nothing, whether or not the call looks at its signal", async () => {
    let calls = 0;
    const ignoring: HttpCall = () => {
      calls++;
      return new Promise(() => undefined);
    };
    const expired = new Transport({ baseUrl: "http://127.0.0.1:1", key: KEY, userAgent: "test", call: ignoring, redact: makeRedactor(KEY) });
    const started = performance.now();
    const error = await expired.exchange({ method: "POST", path: "/x", timeoutMs: 30_000, capAt: () => started - 1 }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NetworkError && error.timedOut, String(error));
    assert.ok(performance.now() - started < 1000);
    assert.equal(calls, 0, "a request that was out of time before it started was sent");
  });

  it("without a cap only its total timeout ends it", async () => {
    const started = performance.now();
    const error = await transport().exchange({ method: "GET", path: "/x", timeoutMs: 150 }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NetworkError && error.timedOut, String(error));
    assert.ok(performance.now() - started >= 150 - TOLERANCE && performance.now() - started < 2500);
  });

  it("the caller's signal ends it at once", async () => {
    const controller = new AbortController();
    const outcome = transport().exchange({ method: "GET", path: "/x", timeoutMs: 30_000, signal: controller.signal }).then(() => undefined, (e: unknown) => e);
    await sleep(20);
    controller.abort(new Error("cancelled"));
    assert.equal(((await outcome) as Error).message, "cancelled");
  });
});

describe("the key never leaks", { concurrency: true }, () => {
  /** The key appears nowhere in the error: message, stack, own properties, the whole cause chain, or inspect output. */
  function assertNoKey(error: unknown, what: string): void {
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      const text = [String((value as Error).message), String((value as Error).stack), JSON.stringify(value, Object.getOwnPropertyNames(value))].join("\n");
      assert.ok(!text.includes(KEY), `${what}: the key is in ${text.slice(0, 300)}`);
      for (const name of Object.getOwnPropertyNames(value)) walk((value as Record<string, unknown>)[name]);
    };
    walk(error);
    assert.ok(!inspect(error, { depth: 10, showHidden: true }).includes(KEY), `${what}: the key is in inspect()`);
    assert.ok(!String(error).includes(KEY), `${what}: the key is in String()`);
  }

  async function failure(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a failure");
  }

  it("is not in errors from validation, the server, the transport or a task result", async (t) => {
    const { api, client, make } = await harness(t);

    // A validation message that echoes a rejected value which happens to be the key.
    const bad = task();
    bad.mailFilters[0]!.comparator = KEY as never;
    const validation = await failure(client.createTask(bad));
    assert.ok(validation instanceof InvalidRequestError);
    assertNoKey(validation, "validation");

    // A server message that echoes it.
    api.fail("create", { kind: "status", status: 400, body: { error: `mailFilters[0].comparator has invalid value "${KEY}"` } });
    const echoed = await failure(client.createTask(task()));
    assert.ok(echoed instanceof InvalidRequestError);
    assertNoKey(echoed, "server echo");
    assert.match((echoed as MailmanError).message, /\[redacted\]/);

    // 401, and a timeout whose cause is a 401.
    api.connected = false;
    const auth = await failure(client.verify());
    assert.ok(auth instanceof AuthError);
    assertNoKey(auth, "401");
    const id = await (async () => {
      api.connected = true;
      return client.createTask(task());
    })();
    api.connected = false;
    assertNoKey(await failure(client.wait(id, { timeoutMs: 200 })), "timeout after 401s");

    // A transport failure.
    api.fail("completed", { kind: "drop" });
    api.connected = true;
    assertNoKey(await failure(client.poll()), "dropped connection");

    // A foreign fetch whose errors mention the key, as a buggy proxy layer might.
    const leaky = make({
      fetch: async () => {
        throw new TypeError(`bad header Authorization: Token ${KEY}`, { cause: Object.assign(new Error(`inner ${KEY}`), { code: "EINVAL" }) });
      },
    });
    const foreign = await failure(leaky.createTask(task()));
    assert.ok(foreign instanceof NetworkError);
    assertNoKey(foreign, "foreign fetch error");

    // A polling loop that crashes on something foreign that mentions the key.
    const crashing = make({ timing: { random: () => { throw new Error(`jitter source broke: ${KEY}`); } } });
    const crashId = await crashing.createTask(task());
    api.fail("completed", { kind: "status", status: 503 });
    const crashed = await failure(crashing.wait(crashId, { timeoutMs: 3000 }));
    assert.ok(crashed instanceof MailmanError);
    assert.match(crashed.message, /stopped unexpectedly/);
    assertNoKey(crashed, "loop crash");

    // A task that failed with a message that echoes the key.
    api.onCreate = () => ({ afterMs: 5, result: { status: "error", results: { errorStatus: "invalid mail task", errorMessage: `regex ${KEY} is bad` } } });
    const failed = await failure(client.run(task(), { timeoutMs: 3000 }));
    assert.ok(failed instanceof TaskFailedError);
    assertNoKey(failed, "task failure");
  });

  it("is not in the unknown-task error, which echoes the id and the configured group, nor in its fields", async (t) => {
    const { api, make } = await harness(t);
    const client = make({ group: KEY }); // a group that happens to be the key
    for (const id of [KEY, `x${KEY}y`, "plain-id"]) assertNoKey(await failure(client.wait(id)), `unknown task ${id.slice(0, 8)}`);

    // With a deadline the error is a TaskTimeoutError: the id and the group are structured fields too.
    const timeout = await failure(client.wait(KEY, { timeoutMs: 60 }));
    assert.ok(timeout instanceof TaskTimeoutError);
    assertNoKey(timeout, "timeout for a foreign id");
    assert.ok(!String(timeout.taskId).includes(KEY) && !timeout.group.includes(KEY), "a structured field holds the key");

    // The group a task was created in, and the group the caller asked for.
    const id = await client.createTask(task({ group: KEY }));
    assertNoKey(await failure(client.wait(id, { group: `other${KEY}` })), "group mismatch");

    // A task whose creation timed out names its group.
    api.fail("create", { kind: "hang" });
    const unconfirmed = await failure(client.run(task({ group: KEY }), { timeoutMs: 60 }));
    assert.ok(unconfirmed instanceof TaskTimeoutError);
    assertNoKey(unconfirmed, "creation timeout");
    assert.ok(!unconfirmed.group.includes(KEY));

    // A finished task: the id and the result's own words.
    api.onCreate = () => ({ afterMs: 5, result: { status: "timeout" } });
    const timedOut = await failure(client.run(task({ group: KEY }), { timeoutMs: 5000 }));
    assert.ok(timedOut instanceof TaskTimeoutError);
    assertNoKey(timedOut, "task timeout");
    assert.ok(!timedOut.group.includes(KEY));
  });

  it("is not in the client object, its JSON or its inspect output", async (t) => {
    const { client } = await harness(t);
    for (const text of [inspect(client, { depth: 10, showHidden: true }), JSON.stringify(client), String(client)]) assert.ok(!text.includes(KEY));
  });

  it("is not in the URL of any request", async (t) => {
    const { api, client } = await harness(t);
    await client.verify();
    await client.createTask(task({ group: KEY.slice(0, 12) }));
    await client.poll("g");
    for (const seen of api.seen) assert.ok(!seen.url.includes(KEY));
  });

  it("refuses a malformed key without echoing it", () => {
    for (const bad of ["has space in it 0123456789", "line\nbreak0123456789", "tab\there0123456789", "ünï-cödé-key-0123456789"]) {
      assert.throws(
        () => new MailmanTasks(bad),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.ok(!error.message.includes(bad));
          return true;
        },
      );
    }
    assert.throws(() => new MailmanTasks(""), TypeError);
    assert.throws(() => new MailmanTasks(undefined as unknown as string), TypeError);
  });
});

describe("configuration", { concurrency: true }, () => {
  it("defaults to the hosted API and group 'default'", () => {
    const client = new MailmanTasks(KEY);
    assert.equal(client.baseUrl, "https://tasks.getmailman.app");
    assert.equal(client.group, "default");
  });

  it("only sends the key over https, except to this machine", () => {
    assert.throws(() => new MailmanTasks(KEY, { baseUrl: "http://tasks.getmailman.app" }), /https/);
    assert.throws(() => new MailmanTasks(KEY, { baseUrl: "http://192.168.1.20:8080" }), /https/);
    assert.throws(() => new MailmanTasks(KEY, { baseUrl: "ftp://x.example" }), /https/);
    assert.throws(() => new MailmanTasks(KEY, { baseUrl: "not a url" }), TypeError);
    new MailmanTasks(KEY, { baseUrl: "http://127.0.0.1:18101" });
    new MailmanTasks(KEY, { baseUrl: "http://localhost:3000" });
    new MailmanTasks(KEY, { baseUrl: "https://tasks.example.com" });
  });

  it("refuses a base URL that carries credentials, a query or a fragment", () => {
    for (const baseUrl of ["https://user:pass@x.example", "https://x.example/?a=1", "https://x.example/#frag"]) {
      assert.throws(() => new MailmanTasks(KEY, { baseUrl }), TypeError, baseUrl);
    }
  });

  it("drops a trailing slash and keeps a path prefix", () => {
    assert.equal(new MailmanTasks(KEY, { baseUrl: "https://x.example/" }).baseUrl, "https://x.example");
    assert.equal(new MailmanTasks(KEY, { baseUrl: "https://x.example/tasks//" }).baseUrl, "https://x.example/tasks");
  });

  it("validates its options", () => {
    assert.throws(() => new MailmanTasks(KEY, { requestTimeoutMs: 0 }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { requestTimeoutMs: Number.NaN }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { timing: { pollIntervalMs: 0 } }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { timing: { maxCreateAttempts: 0 } }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { timing: { maxCreateAttempts: 1.5 } }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { timing: { random: 1 as never } }), TypeError);
    assert.throws(() => new MailmanTasks(KEY, { limits: { maxTrackedTasks: 0 } }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { limits: { resultTtlMs: -1 } }), RangeError);
    assert.throws(() => new MailmanTasks(KEY, { userAgent: "bad\nagent" }), TypeError);
    assert.throws(() => new MailmanTasks(KEY, { group: 5 as never }), InvalidRequestError);
    assert.throws(() => new MailmanTasks(KEY, { group: "x".repeat(1025) }), InvalidRequestError);
  });

  it("takes the timing defaults from the API's rules", async (t) => {
    // Observable without waiting: a failing create sleeps for the documented first backoff, 1 s plus up to 25%.
    const { api } = await harness(t);
    const client = new MailmanTasks(api.key, { baseUrl: api.url, timing: { maxCreateAttempts: 2 } });
    api.fail("create", { kind: "status", status: 503 });
    const started = performance.now();
    await client.createTask(task());
    const slept = performance.now() - started;
    assert.ok(slept >= 1000 && slept < 1250 + 400, `slept ${slept} ms`);
    void FAST;
    void TaskTimeoutError;
  });
});
