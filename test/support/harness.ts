import type { TestContext } from "node:test";
import { MailmanTasks, type ClientOptions, type TaskInput, type Timing } from "../../src/index.js";
import { MockApi } from "./mock-api.js";

/** Short intervals so the suite is fast; the logic under test is the same. */
export const FAST: Partial<Timing> = {
  pollIntervalMs: 40,
  fullPageIntervalMs: 12,
  unauthorizedDelayMs: 70,
  backoffBaseMs: 15,
  backoffMaxMs: 120,
  deadlineGraceMs: 60,
  maxCreateAttempts: 3,
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `condition` holds, or fail after `ms`. */
export async function until(condition: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const limit = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > limit) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** Differences between consecutive numbers. */
export const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i]!);

/** Scheduling noise between two arrival timestamps measured on the same clock. */
export const TOLERANCE = 6;

/** A valid task. */
export function task(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    email: "alias@example.com",
    mailFilters: [{ target: "from", comparator: "includes", value: "noreply@example.com" }],
    mailElements: [{ name: "code", target: "body", regex: "\\b\\d{6}\\b" }],
    ...overrides,
  };
}

export interface Harness {
  api: MockApi;
  client: MailmanTasks;
  /** Another client on the same mock, with the fast timing unless overridden. */
  make(options?: ClientOptions): MailmanTasks;
}

/** A mock API plus a client for it, both closed when the test ends. */
export async function harness(t: TestContext, options: ClientOptions = {}): Promise<Harness> {
  const api = await MockApi.start();
  const clients: MailmanTasks[] = [];
  const make = (extra: ClientOptions = {}): MailmanTasks => {
    const client = new MailmanTasks(api.key, {
      baseUrl: api.url,
      ...extra,
      timing: { ...FAST, ...extra.timing },
    });
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) client.close();
    await api.close();
  });
  return { api, client: make(options), make };
}

/** The next poll is held at the server until the returned function is called: it stays in flight as long as a test wants. */
export function holdNextPoll(api: MockApi): () => void {
  let release: () => void = () => undefined;
  api.fail("completed", { kind: "hold", release: new Promise<void>((resolve) => (release = resolve)) });
  return () => release();
}

/** Auto-finish every created task with `results` after a few ms. */
export function autoFinish(api: MockApi, results: Record<string, string> | ((task: Record<string, any>) => Record<string, string>) = { code: "123456" }, afterMs = 5): void {
  api.onCreate = (task) => ({ afterMs, result: { status: "success", results: typeof results === "function" ? results(task) : results } });
}
