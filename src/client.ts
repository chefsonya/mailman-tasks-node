import {
  AuthError,
  InvalidRequestError,
  MailmanError,
  NetworkError,
  RateLimitError,
  RequestTimeoutError,
  ServerBusyError,
  TaskFailedError,
  TaskTimeoutError,
  TooManyTasksError,
} from "./errors.js";
import { backoffMs, Lease, PollGate, type Outcome } from "./gate.js";
import { Held, nodeHttp, type HttpCall } from "./http.js";
import { makeRedactor, sanitizeCause, type Redactor } from "./redact.js";
import { errorFor, Transport, type Exchange } from "./transport.js";
import type {
  ClientOptions,
  ClientStats,
  CreateOptions,
  DeadlineOptions,
  Limits,
  PollOptions,
  RunOptions,
  SuccessResult,
  TaskInput,
  TaskResult,
  TaskStatus,
  Timing,
  VerifyOptions,
  WaitOptions,
} from "./types.js";
import { abortReason, anySignal, isObject, now, sleep, timerDelay, unrefTimer, untilAborted, type Timer } from "./util.js";
import { checkGroup, prepareTask, type PreparedTask } from "./validate.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://tasks.getmailman.app";
const CREATE_PATH = "/api/v1/tasks/mail/create";
const COMPLETED_PATH = "/api/v1/tasks/completed";
const VERIFY_PATH = "/api/v1/user/verify";
/** Results one /completed call returns at most; a full page means more are waiting. */
const COMPLETED_PAGE = 100;

const DEFAULT_TIMING: Timing = {
  pollIntervalMs: 3000,
  fullPageIntervalMs: 1000,
  unauthorizedDelayMs: 10_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  deadlineGraceMs: 15_000,
  maxCreateAttempts: 3,
  maxRetryAfterMs: 60_000,
  random: Math.random,
};

const DEFAULT_LIMITS: Limits = {
  maxTrackedTasks: 50_000,
  maxUnclaimedResults: 10_000,
  maxRetainedResults: 10_000,
  resultTtlMs: 3_600_000,
};

/** What the client knows about a task it created: where its result will be, and until when to wait. */
interface TaskEntry {
  group: string;
  /** Monotonic ms. */
  deadlineAt: number;
  /** A result has arrived. The entry then lives and dies with that result. */
  done: boolean;
}

interface Waiter {
  id: string;
  /** Monotonic ms. */
  deadlineAt: number;
  resolve(result: TaskResult): void;
  reject(error: unknown): void;
}

/** A result the client holds. It is stored before anybody is told and stays readable until it expires. */
interface Stored {
  group: string;
  id: string;
  result: TaskResult;
  /** Monotonic ms: the TTL after it arrived. */
  expiresAt: number;
  /** Whether this client created the task. */
  tracked: boolean;
  /**
   * Whether it has been handed out, to a `wait` or by `poll()`. Until then it is protected from eviction;
   * afterwards it is a readable copy that only the retention cap can drop early.
   */
  delivered: boolean;
}

/** Everything the client keeps per group. It is dropped again once the group is idle. */
class GroupState {
  readonly waiters = new Map<string, Waiter[]>();
  waiting = 0;
  /** `poll()` calls in progress: like a waiter, each needs the process to stay up for what is in flight. */
  callers = 0;
  /**
   * Held while a waiter or a `poll()` caller is there. A request in flight when the last one leaves is not cut (the server
   * deletes results as it answers); it just stops keeping the process alive, until somebody comes back.
   */
  readonly hold = new Held(false);
  /** The polling loop, while one runs. Cleared by the loop itself, whatever way it ends. */
  worker: Promise<void> | undefined;
  /** Ends the loop's wait for its turn when the last waiter leaves. A request already in flight is not its business. */
  stop: AbortController | undefined;
  lastError: MailmanError | undefined;
  retireTimer: Timer | undefined;

  constructor(
    readonly name: string,
    readonly gate: PollGate,
  ) {}
}

/** The answer of /completed was not what the API documents. Counts as a transient failure. */
class UnreadableResponseError extends MailmanError {}

const storeKey = (group: string, id: string): string => `${group}\u0000${id}`;

/** What a caller gets: a copy, so changing it can't change what the next `wait` returns. */
const copyOf = (result: TaskResult): TaskResult => ({
  id: result.id,
  status: result.status,
  ...(result.results ? { results: { ...result.results } } : {}),
});

/**
 * Client for Mailman's hosted Tasks API.
 *
 * One client keeps one polling loop per group, started by the first `wait` and stopped when no
 * `wait` is left, so any number of concurrent `run()` calls cost one request every few seconds.
 * Use one client per key and group; two pollers on one group split its results between them.
 */
export class MailmanTasks {
  /** The group tasks are created in and waited on by default. */
  readonly group: string;
  readonly baseUrl: string;

  readonly #redact: Redactor;
  readonly #transport: Transport;
  readonly #timing: Timing;
  readonly #limits: Limits;
  readonly #requestTimeoutMs: number;
  /** Aborts every request, retry sleep and queued turn when the client is closed. */
  readonly #lifetime = new AbortController();
  readonly #tasks = new Map<string, TaskEntry>();
  readonly #groups = new Map<string, GroupState>();
  /** Every result received, oldest first, so expiry only looks at the front. Keyed by group and id. */
  readonly #results = new Map<string, Stored>();
  /** Keys of the results already handed out, in the order they were: the retention cap drops the oldest. */
  readonly #deliveredKeys = new Set<string>();
  /** Stored results nobody has taken, of tasks this client didn't create. */
  #unclaimed = 0;
  /** Handed-out results of tasks this client created: they no longer count against `maxTrackedTasks`. */
  #deliveredTracked = 0;
  #reserved = 0;
  #closed = false;

  constructor(apiKey: string, options: ClientOptions = {}) {
    if (typeof apiKey !== "string" || apiKey === "") throw new TypeError("apiKey is required");
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new TypeError("apiKey must be the key as copied from Mailman: no spaces, line breaks or other special characters");
    }
    this.#redact = makeRedactor(apiKey);
    this.group = checkGroup(options.group ?? "default", this.#redact);
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#timing = resolveTiming(options.timing);
    this.#limits = resolveLimits(options.limits);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    positive("requestTimeoutMs", this.#requestTimeoutMs);
    const userAgent = options.userAgent ?? `mailman-tasks-node/${VERSION}`;
    if (typeof userAgent !== "string" || !/^[\x20-\x7e]+$/.test(userAgent)) {
      throw new TypeError("userAgent must be printable ASCII");
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") throw new TypeError("fetch must be a function");
    const call: HttpCall = options.fetch ?? nodeHttp;
    this.#transport = new Transport({ baseUrl: this.baseUrl, key: apiKey, userAgent, call, redact: this.#redact });
  }

  /** `true` when the key is valid and the user's Mailman is open and connected; throws {@link AuthError} otherwise (rule S1). */
  async verify(options: VerifyOptions = {}): Promise<true> {
    this.#assertOpen();
    await this.#request({ method: "GET", path: VERIFY_PATH, signal: options.signal }, "safe");
    return true;
  }

  /**
   * Create a task and return its id. `receivedAt` defaults to now (in seconds), `timeout` to 300 s
   * (at most 3600) and `group` to the client's group; `wait(id)` polls the same group.
   *
   * Retries only what the API says is safe: 429 and 503 answers, honouring Retry-After, about
   * three attempts. A dropped connection, a reset or a timeout is never retried (the task might
   * exist, and a retry would create it twice); it throws {@link NetworkError}.
   */
  async createTask(task: TaskInput, options: CreateOptions = {}): Promise<string> {
    const { id } = await this.#create(this.#prepare(task), { signal: options.signal });
    return id;
  }

  /**
   * One destructive `GET /completed`: the results it returns are gone from the server (rule M7).
   * They are also stored in this client, so a `wait(id)` for one of them still resolves for an
   * hour, but you must store what you get. The call waits its turn at the group's gate, so it
   * never comes sooner after another poll than the API allows.
   *
   * `signal` ends this call, and cancels it for good while it still waits for its turn. A request that is
   * already out is not cut by it: the server deletes the results as it writes the answer, so the request
   * finishes in the background and stores what it carries for later `wait`s. Only {@link close} cuts it
   * (and what it carries is lost), and its own timeout, `timeoutMs`.
   */
  async poll(group?: string, options: PollOptions = {}): Promise<TaskResult[]> {
    this.#assertOpen();
    const name = group === undefined ? this.group : checkGroup(group, this.#redact);
    const state = this.#group(name);
    const link = anySignal(options.signal, this.#lifetime.signal);
    // The caller needs the process to stay up for a request in flight, like a waiter, until it stops waiting.
    let waiting = true;
    state.callers += 1;
    this.#syncHold(state);
    try {
      const lease = await state.gate.acquire(link.signal);
      // Only close() cuts the request. If the caller has gone by the time it answers, the results are stored
      // for later; if not, the caller gets them, so they are stored as handed out: readable by wait(id) until they expire.
      const request = this.#pollOnce(state, lease, {
        signal: this.#lifetime.signal,
        timeoutMs: options.timeoutMs,
        handedOut: () => waiting,
      });
      request.then(
        () => this.#maybeRetire(state),
        () => this.#maybeRetire(state),
      );
      return await untilAborted(request, link.signal);
    } finally {
      link.dispose();
      waiting = false;
      state.callers -= 1;
      this.#syncHold(state);
      this.#maybeRetire(state);
    }
  }

  /**
   * The result of a task, whatever its status (`run` turns failures into errors). All waits of a
   * group share one polling loop. A result that arrived before the call is returned at once, and
   * so is one that was already delivered: every result is kept for an hour after it arrived, so
   * a second `wait` on the same id returns it again (for example after a sibling `wait` in a
   * `Promise.all` failed). After the deadline (default: the task's timeout plus 15 s, counted from
   * its creation) it throws {@link TaskTimeoutError}: the task is lost, create it again.
   *
   * A deadline, or a `signal`, ends this call and nothing else. It decides whether another poll is started, never
   * whether one that is already out is cut: the server deletes the results as it writes the answer, so a poll cut
   * at a deadline would lose every result in it, other tasks' codes included. The call returns on time; the poll
   * finishes in the background and stores its results for later `wait`s (for an hour). When nobody is waiting any
   * more no further poll starts, and the one in flight no longer keeps the process alive.
   *
   * A task id this client didn't create needs `timeoutMs` or `deadline`, and `group` if it isn't in the client's group.
   */
  async wait(id: string, options: WaitOptions = {}): Promise<TaskResult> {
    this.#assertOpen();
    if (typeof id !== "string" || id === "") throw new InvalidRequestError("wait needs a task id");
    this.#prune(now()); // an id whose result just expired is unknown now, not a task to wait a whole deadline for
    const { group, deadlineAt } = this.#target(id, options);
    return this.#await(id, group, deadlineAt, options.signal);
  }

  /**
   * `createTask` then `wait`. Returns the successful result; throws {@link TaskFailedError} for
   * `status: "error"` and {@link TaskTimeoutError} for `status: "timeout"` or a passed deadline.
   * With `timeoutMs` or `deadline`, that deadline bounds the whole call, creation and its retries included.
   * The create is cut at the deadline; a poll that is already out never is (see {@link wait}).
   */
  async run(task: TaskInput, options: RunOptions = {}): Promise<SuccessResult> {
    this.#assertOpen();
    const prepared = this.#prepare(task);
    const start = now();
    const explicit = this.#explicitDeadline(options, start);
    const createBy = explicit ?? start + prepared.timeoutSecs * 1000 + this.#timing.deadlineGraceMs;
    const { id, entry } = await this.#create(prepared, { signal: options.signal, deadlineAt: createBy });
    const result = await this.#await(id, entry.group, explicit ?? entry.deadlineAt, options.signal);
    if (result.status === "success") return { ...result, status: "success", results: result.results ?? {} };
    if (result.status === "error") {
      const results = result.results ?? {};
      throw new TaskFailedError(this.#redact(id), this.#redact(results.errorStatus ?? ""), this.#redact(results.errorMessage ?? ""));
    }
    if (result.status === "timeout") throw new TaskTimeoutError(this.#redact(id), this.#redact(entry.group), "timeout");
    throw new MailmanError(this.#redact(`Task ${id} finished with an unknown status ${JSON.stringify(result.status)}.`));
  }

  /** What the client is holding right now. For diagnostics and tests. */
  stats(): ClientStats {
    this.#prune(now());
    let pollers = 0;
    let waiters = 0;
    for (const state of this.#groups.values()) {
      if (state.worker) pollers++;
      waiters += state.waiting;
    }
    const retained = this.#deliveredKeys.size;
    return {
      trackedTasks: this.#tasks.size,
      groups: this.#groups.size,
      pollers,
      waiters,
      bufferedResults: this.#results.size - retained,
      retainedResults: retained,
    };
  }

  /**
   * Stop everything: in-flight requests are aborted (their sockets closed), retry sleeps end and no
   * further attempt is made, polling stops and every `wait` in progress is rejected. The client
   * cannot be used afterwards.
   *
   * This is the one thing that cuts a poll that is in flight, and what that poll was carrying is lost: the
   * server had already deleted those results. Close the client once nothing more is expected.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new MailmanError("The client was closed.");
    this.#lifetime.abort(error);
    for (const state of this.#groups.values()) {
      clearTimeout(state.retireTimer);
      state.stop?.abort();
      this.#failWaiters(state, error);
    }
    this.#groups.clear();
  }

  // ---- creating ----------------------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closed) throw new MailmanError("The client was closed.");
  }

  #prepare(task: TaskInput): PreparedTask {
    return prepareTask(task, { defaultGroup: this.group, nowSeconds: Math.floor(Date.now() / 1000), redact: this.#redact });
  }

  async #create(
    prepared: PreparedTask,
    options: { signal?: AbortSignal | undefined; deadlineAt?: number },
  ): Promise<{ id: string; entry: TaskEntry }> {
    this.#assertOpen();
    this.#reserve();
    try {
      const exchange = await this.#request(
        { method: "POST", path: CREATE_PATH, body: prepared.json, signal: options.signal, deadlineAt: options.deadlineAt },
        "create",
        (cause) => new TaskTimeoutError(undefined, this.#redact(prepared.group), "deadline", cause === undefined ? {} : { cause }),
      );
      const id = parseCreated(exchange.text);
      const entry: TaskEntry = {
        group: prepared.group,
        deadlineAt: now() + prepared.timeoutSecs * 1000 + this.#timing.deadlineGraceMs,
        done: false,
      };
      // The routing metadata exists before the id is handed out.
      this.#tasks.set(id, entry);
      this.#adopt(id, entry);
      return { id, entry };
    } finally {
      this.#reserved--;
    }
  }

  /**
   * A fast task can finish, and a poll can collect its result, while the answer to its create is still on the wire.
   * That result was filed as somebody else's, because the task wasn't known yet. Now it is: make the result the
   * task's own, so it counts, is protected and expires with its task like any other.
   */
  #adopt(id: string, entry: TaskEntry): void {
    const stored = this.#results.get(storeKey(entry.group, id));
    if (!stored || stored.tracked) return;
    stored.tracked = true;
    entry.done = true;
    if (stored.delivered) this.#deliveredTracked++;
    else this.#unclaimed--;
  }

  /** Tasks that count against `maxTrackedTasks`: everything tracked except results already handed out. */
  #live(): number {
    return this.#tasks.size - this.#deliveredTracked;
  }

  /** Room for one more live task, reclaiming only what is finished or expired. Throws before anything is sent. */
  #reserve(): void {
    const max = this.#limits.maxTrackedTasks;
    if (this.#live() + this.#reserved >= max) {
      this.#reclaim();
      if (this.#live() + this.#reserved >= max) {
        throw new TooManyTasksError(
          `This client already tracks ${max} tasks that are still pending or whose result nobody has taken yet. Collect results with wait() before creating more.`,
          max,
        );
      }
    }
    this.#reserved++;
  }

  /**
   * Forget results past their TTL, and tasks whose deadline passed with no result and no waiter. A task
   * that is pending, awaited, or has a result is never touched: that result is its routing metadata's reason to live.
   */
  #reclaim(): void {
    const t = now();
    this.#prune(t);
    for (const [id, entry] of this.#tasks) {
      if (entry.done || t <= entry.deadlineAt) continue;
      if (this.#groups.get(entry.group)?.waiters.has(id)) continue;
      this.#tasks.delete(id);
    }
  }

  /**
   * One request with the retry rules of its kind. Retries only explicit answers: 429 and 503 for a
   * create (a repeat could duplicate the task after anything else), those plus 408/5xx and
   * dropped connections for a safe GET. Sleeps the longer of the backoff and Retry-After, never
   * past `deadlineAt`, and never once the caller's `signal` or the client's own has fired.
   */
  async #request(
    spec: { method: "GET" | "POST"; path: string; body?: string; signal?: AbortSignal | undefined; deadlineAt?: number | undefined },
    retry: "create" | "safe",
    onDeadline?: (cause?: unknown) => Error,
  ): Promise<Exchange> {
    const { deadlineAt } = spec;
    // The caller's signal and close() both end this call: the request, and the sleeps between attempts.
    const link = anySignal(spec.signal, this.#lifetime.signal);
    const signal = link.signal;
    const expired = (cause?: unknown): Error => onDeadline?.(cause) ?? new MailmanError("The deadline passed.");
    const timing = this.#timing;

    // Milliseconds to sleep before the next attempt; undefined means give up.
    const delayAfter = (error: MailmanError, attempt: number): number | undefined => {
      if (attempt >= timing.maxCreateAttempts) return undefined;
      const retryAfterMs = error.retryAfter * 1000;
      if (retryAfterMs > timing.maxRetryAfterMs) return undefined;
      const ms = Math.max(backoffMs(timing, attempt), retryAfterMs);
      if (deadlineAt !== undefined && now() + ms >= deadlineAt) return undefined;
      return ms;
    };

    try {
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw abortReason(signal);
        if (deadlineAt !== undefined && now() >= deadlineAt) throw expired();

        let exchange: Exchange;
        try {
          exchange = await this.#transport.exchange({
            method: spec.method,
            path: spec.path,
            body: spec.body,
            signal,
            timeoutMs: this.#requestTimeoutMs,
            capAt: deadlineAt === undefined ? undefined : () => deadlineAt,
          });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          if (deadlineAt !== undefined && error.timedOut && now() >= deadlineAt) throw expired(error);
          const ms = retry === "safe" ? delayAfter(error, attempt) : undefined;
          if (ms === undefined) throw error;
          await sleep(ms, signal);
          continue;
        }

        if (exchange.status >= 200 && exchange.status < 300) return exchange;
        const error = errorFor(exchange, this.#redact);
        const retryable =
          error instanceof ServerBusyError ||
          error instanceof RateLimitError ||
          (retry === "safe" && (error instanceof RequestTimeoutError || error.status >= 500));
        const ms = retryable ? delayAfter(error, attempt) : undefined;
        if (ms === undefined) throw error;
        await sleep(ms, signal);
      }
    } finally {
      link.dispose();
    }
  }

  // ---- waiting -----------------------------------------------------------------------------

  /** Monotonic deadline from `timeoutMs` / `deadline` (the earlier wins), or undefined when neither is set. */
  #explicitDeadline(options: DeadlineOptions, start: number): number | undefined {
    const candidates: number[] = [];
    const { timeoutMs, deadline } = options;
    if (timeoutMs !== undefined) {
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new InvalidRequestError("timeoutMs must be a number of milliseconds, 0 or more");
      }
      candidates.push(start + timeoutMs);
    }
    if (deadline !== undefined) {
      const at = deadline instanceof Date ? deadline.getTime() : deadline;
      if (typeof at !== "number" || !Number.isFinite(at)) {
        throw new InvalidRequestError("deadline must be a Date or epoch milliseconds");
      }
      // Wall clock to monotonic, once, here; from now on only the monotonic clock counts.
      candidates.push(start + (at - Date.now()));
    }
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  /** Which group a wait polls and when it gives up. A task's own group wins; there is no fallback to the default group. */
  #target(id: string, options: WaitOptions): { group: string; deadlineAt: number } {
    const entry = this.#tasks.get(id);
    const explicit = this.#explicitDeadline(options, now());
    const asked = options.group === undefined ? undefined : checkGroup(options.group, this.#redact);
    if (entry) {
      if (asked !== undefined && asked !== entry.group) {
        throw new InvalidRequestError(
          this.#redact(`Task ${id} was created in group ${JSON.stringify(entry.group)}, not ${JSON.stringify(asked)}.`),
        );
      }
      return { group: entry.group, deadlineAt: explicit ?? entry.deadlineAt };
    }
    if (explicit === undefined) {
      // The id and the group are the caller's words; either could be the key.
      throw new InvalidRequestError(
        this.#redact(
          `This client didn't create task ${id}, or has forgotten it (a result is kept for an hour). To wait for it anyway pass timeoutMs or deadline, and group if it isn't ${JSON.stringify(this.group)}.`,
        ),
      );
    }
    return { group: asked ?? this.group, deadlineAt: explicit };
  }

  #await(id: string, group: string, deadlineAt: number, signal: AbortSignal | undefined): Promise<TaskResult> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    // A stored result answers at once, however often it is asked for and whether or not it was delivered before.
    const stored = this.#lookup(group, id);
    if (stored) return Promise.resolve(this.#handOut(stored));
    if (now() >= deadlineAt) return Promise.reject(this.#deadlineError(this.#groups.get(group), group, id));

    const state = this.#group(group);
    return new Promise<TaskResult>((resolve, reject) => {
      let settled = false;
      let timer: Timer | undefined;
      const waiter: Waiter = {
        id,
        deadlineAt,
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#removeWaiter(state, waiter);
        finish();
      };
      const onAbort = () => waiter.reject(abortReason(signal));
      // The timer may fire a tick early; the monotonic clock decides.
      const arm = () => {
        const left = deadlineAt - now();
        if (left > 0) timer = setTimeout(arm, timerDelay(left));
        else waiter.reject(this.#deadlineError(state, group, id));
      };

      this.#addWaiter(state, waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      arm();
      this.#ensurePoller(state);
    });
  }

  #deadlineError(state: GroupState | undefined, group: string, id: string): TaskTimeoutError {
    // If the key was rejected the whole time, say so: the last poll's error rides along as the cause.
    // The id and the group are the caller's words, so they are redacted like any message.
    return new TaskTimeoutError(this.#redact(id), this.#redact(group), "deadline", state?.lastError ? { cause: state.lastError } : {});
  }

  #addWaiter(state: GroupState, waiter: Waiter): void {
    const list = state.waiters.get(waiter.id);
    if (list) list.push(waiter);
    else state.waiters.set(waiter.id, [waiter]);
    state.waiting += 1;
    this.#syncHold(state);
    clearTimeout(state.retireTimer);
  }

  #removeWaiter(state: GroupState, waiter: Waiter): void {
    const list = state.waiters.get(waiter.id);
    if (list) {
      const at = list.indexOf(waiter);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) state.waiters.delete(waiter.id);
    }
    state.waiting -= 1;
    this.#syncHold(state);
    // Nobody left: don't start another poll. A request that is already in flight is left to finish and store its results.
    if (state.waiting === 0) state.stop?.abort();
    this.#maybeRetire(state);
  }

  /** Whoever is waiting (a `wait` or a `poll()` caller) keeps the process alive for a request in flight; nobody, and it doesn't. */
  #syncHold(state: GroupState): void {
    state.hold.set(state.waiting + state.callers > 0);
  }

  #failWaiters(state: GroupState, error: unknown): void {
    for (const list of [...state.waiters.values()]) for (const waiter of [...list]) waiter.reject(error);
  }

  // ---- polling -----------------------------------------------------------------------------

  #group(name: string): GroupState {
    let state = this.#groups.get(name);
    if (!state) {
      state = new GroupState(name, new PollGate(this.#timing));
      this.#groups.set(name, state);
    }
    return state;
  }

  #ensurePoller(state: GroupState): void {
    if (state.worker || this.#closed) return;
    state.stop = new AbortController();
    state.worker = this.#pollerLoop(state).catch(() => undefined);
  }

  /**
   * The group's one polling loop. However it ends, its slot is cleared and no waiter is left
   * hanging: an unexpected failure rejects them, and a waiter that arrived while the loop was
   * winding down gets a fresh loop. All pacing comes from the gate, none from here.
   */
  async #pollerLoop(state: GroupState): Promise<void> {
    await undefined; // lets #ensurePoller store this promise before any of the body runs
    let crash: { error: unknown } | undefined;
    try {
      while (state.waiting > 0 && !this.#closed) {
        let lease: Lease;
        try {
          lease = await state.gate.acquire(state.stop?.signal);
        } catch (error) {
          if (state.stop?.signal.aborted || this.#closed) break;
          throw error;
        }
        if (state.waiting === 0 || this.#closed) {
          lease.skip();
          break;
        }
        try {
          // Deadlines and departing waiters decided whether to start this poll. Once it is out, only close() and the
          // request's own timeout end it: the server deletes what it answers, so cutting it would lose every result in it.
          await this.#pollOnce(state, lease, { signal: this.#lifetime.signal });
        } catch (error) {
          if (!(error instanceof MailmanError)) throw error; // not an API condition: a bug
          if (!isTransient(error)) {
            this.#failWaiters(state, error);
            break;
          }
          // Transient: the gate has already scheduled the next attempt.
        }
      }
    } catch (error) {
      crash = { error };
    } finally {
      state.worker = undefined;
      state.stop = undefined;
      if (crash) {
        const detail = crash.error instanceof Error ? `: ${this.#redact(crash.error.message)}` : "";
        this.#failWaiters(state, new MailmanError(`The polling loop stopped unexpectedly${detail}`, { cause: sanitizeCause(crash.error, this.#redact) }));
      } else if (state.waiting > 0 && !this.#closed) {
        this.#ensurePoller(state);
      }
      this.#maybeRetire(state);
    }
  }

  /**
   * One GET /completed under `lease`. The whole page is stored before any waiter is told, before
   * anything else can fail, and the gate hears how the attempt ended whatever happens.
   *
   * Once sent, the request is never ended by a deadline or because its waiters left: the server deletes the
   * results as it writes the answer, so cutting it would lose every result in it, other tasks' included.
   * It ends with its answer, with its own total timeout, or when `options.signal` (the client's, for `close()`)
   * fires. While nobody waits for it the group's hold lets go of the process.
   */
  async #pollOnce(
    state: GroupState,
    lease: Lease,
    options: {
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
      /** Asked when the answer is in: whether it goes to the caller of poll(), whose results then count as handed out from the start. */
      handedOut?: () => boolean;
    },
  ): Promise<TaskResult[]> {
    let outcome: Outcome = { kind: "failure" };
    try {
      let exchange: Exchange;
      try {
        exchange = await this.#transport.exchange({
          method: "GET",
          path: state.name === "" ? COMPLETED_PATH : `${COMPLETED_PATH}?group=${encodeURIComponent(state.name)}`,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? this.#requestTimeoutMs,
          hold: state.hold,
        });
      } catch (error) {
        if (options.signal?.aborted) outcome = { kind: "aborted" };
        else if (error instanceof MailmanError) state.lastError = error;
        throw error;
      }
      if (exchange.status < 200 || exchange.status >= 300) {
        const error = errorFor(exchange, this.#redact);
        state.lastError = error;
        outcome = error instanceof AuthError ? { kind: "unauthorized" } : { kind: "failure", retryAfterMs: error.retryAfter * 1000 };
        throw error;
      }
      let page: { results: TaskResult[]; count: number };
      try {
        page = parseCompleted(exchange.text);
      } catch (error) {
        state.lastError = error as MailmanError;
        throw error;
      }
      // Store first: from here on nothing may lose these results.
      this.#dispatch(state, page.results, options.handedOut?.() ?? false);
      state.lastError = undefined;
      outcome = { kind: "ok", full: page.count >= COMPLETED_PAGE };
      return page.results;
    } finally {
      lease.done(outcome);
    }
  }

  /** Store the whole page, then tell the waiters. Storing comes first so that nothing a waiter does can cost a result. */
  #dispatch(state: GroupState, results: TaskResult[], handedOut: boolean): void {
    const stored: Stored[] = [];
    for (const result of results) {
      try {
        stored.push(this.#store(state.name, result, handedOut));
      } catch {
        // One bad entry must not cost the rest of the page.
      }
    }
    for (const entry of stored) {
      try {
        this.#notify(state, entry);
      } catch {
        // The result is stored; a later wait still finds it.
      }
    }
  }

  #notify(state: GroupState, stored: Stored): void {
    const waiting = state.waiters.get(stored.id);
    if (!waiting || waiting.length === 0) return;
    for (const waiter of [...waiting]) waiter.resolve(this.#handOut(stored));
  }

  // ---- the result store ------------------------------------------------------------------------

  /** Keep a received result for the TTL, whether or not anyone is waiting for it. Never drops what it holds. */
  #store(group: string, result: TaskResult, handedOut: boolean): Stored {
    const t = now();
    this.#prune(t);
    const key = storeKey(group, result.id);
    const previous = this.#results.get(key);
    if (previous) return previous; // a repeat of an id: the first copy stands
    const entry = this.#tasks.get(result.id);
    const tracked = entry !== undefined && entry.group === group;
    if (entry && tracked) entry.done = true;
    // Its own copy: the object poll() returns to its caller is theirs to change.
    const stored: Stored = { group, id: result.id, result: copyOf(result), expiresAt: t + this.#limits.resultTtlMs, tracked, delivered: false };
    this.#results.set(key, stored);
    if (!tracked) this.#unclaimed++;
    if (handedOut) this.#markDelivered(stored);
    else if (!tracked) this.#boundUnclaimed();
    return stored;
  }

  #lookup(group: string, id: string): Stored | undefined {
    this.#prune(now());
    return this.#results.get(storeKey(group, id));
  }

  /** The caller gets a copy, and from now on the result counts as handed out: readable again, evictable under the retention cap. */
  #handOut(stored: Stored): TaskResult {
    this.#markDelivered(stored);
    return copyOf(stored.result);
  }

  #markDelivered(stored: Stored): void {
    if (stored.delivered) return;
    stored.delivered = true;
    if (stored.tracked) this.#deliveredTracked++;
    else this.#unclaimed--;
    this.#deliveredKeys.add(storeKey(stored.group, stored.id));
    this.#boundRetained();
  }

  /** Drop results past their TTL. They are in arrival order, so only the front can be expired. */
  #prune(t: number): void {
    for (const stored of this.#results.values()) {
      if (stored.expiresAt > t) break;
      this.#evict(stored);
    }
  }

  /** Remove a stored result, and the task it belongs to: a task lives as long as its result does. */
  #evict(stored: Stored): void {
    const key = storeKey(stored.group, stored.id);
    if (this.#results.get(key) !== stored) return;
    this.#results.delete(key);
    if (stored.delivered) {
      this.#deliveredKeys.delete(key);
      if (stored.tracked) this.#deliveredTracked--;
    } else if (!stored.tracked) {
      this.#unclaimed--;
    }
    if (stored.tracked) this.#tasks.delete(stored.id);
  }

  /** Results nobody has taken, of tasks this client didn't create, are bounded; the oldest go first. */
  #boundUnclaimed(): void {
    const max = this.#limits.maxUnclaimedResults;
    if (this.#unclaimed <= max) return;
    for (const stored of this.#results.values()) {
      if (stored.tracked || stored.delivered) continue;
      this.#evict(stored);
      if (this.#unclaimed <= max) return;
    }
  }

  /** Handed-out results are kept for repeat reads, but only the newest `maxRetainedResults` of them. */
  #boundRetained(): void {
    while (this.#deliveredKeys.size > this.#limits.maxRetainedResults) {
      const key = this.#deliveredKeys.values().next().value as string;
      const oldest = this.#results.get(key);
      if (oldest) this.#evict(oldest);
      else this.#deliveredKeys.delete(key);
    }
  }

  // ---- retiring idle groups -------------------------------------------------------------------

  /** Drop a group's bookkeeping once nothing is running or waiting and its pacing has run out. */
  #maybeRetire(state: GroupState): void {
    if (this.#groups.get(state.name) !== state) return;
    if (state.worker || state.waiting > 0 || state.gate.busy || state.gate.queued > 0) return;
    clearTimeout(state.retireTimer);
    state.retireTimer = undefined;
    const t = now();
    const at = state.gate.idleAfter;
    if (t >= at) {
      this.#groups.delete(state.name);
      return;
    }
    state.retireTimer = unrefTimer(
      setTimeout(() => {
        state.retireTimer = undefined;
        this.#maybeRetire(state);
      }, timerDelay(at - t)),
    );
  }
}

// ---- helpers ---------------------------------------------------------------------------------

/** Failures a poller should ride out; anything else (a 400, a 404, a redirect) would never get better. */
function isTransient(error: MailmanError): boolean {
  return (
    error instanceof AuthError ||
    error instanceof RateLimitError ||
    error instanceof ServerBusyError ||
    error instanceof RequestTimeoutError ||
    error instanceof NetworkError ||
    error instanceof UnreadableResponseError ||
    error.status === 421 || // misdirected: the request was not processed. fetch used to re-send it by itself; now the gate paces it
    error.status >= 500
  );
}

function parseCreated(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isObject(body) && typeof body.id === "string" && body.id !== "") return body.id;
  } catch {
    // fall through
  }
  throw new MailmanError("The Tasks API accepted the task but its answer could not be read. The task may exist.", { status: 200 });
}

function parseCompleted(text: string): { results: TaskResult[]; count: number } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UnreadableResponseError("The Tasks API answered /completed with something that is not JSON.", { status: 200 });
  }
  const tasks = isObject(body) ? body.tasks : undefined;
  if (!Array.isArray(tasks)) {
    throw new UnreadableResponseError("The Tasks API answered /completed without a task list.", { status: 200 });
  }
  const results: TaskResult[] = [];
  for (const task of tasks as unknown[]) {
    if (!isObject(task) || typeof task.id !== "string" || typeof task.status !== "string") continue;
    const result: TaskResult = { id: task.id, status: task.status as TaskStatus };
    if (isObject(task.results)) {
      result.results = Object.fromEntries(Object.entries(task.results).map(([key, value]) => [key, String(value)]));
    }
    results.push(result);
  }
  return { results, count: tasks.length };
}

function positive(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
}

function resolveTiming(partial: Partial<Timing> | undefined): Timing {
  const timing: Timing = { ...DEFAULT_TIMING, ...partial };
  positive("timing.pollIntervalMs", timing.pollIntervalMs);
  positive("timing.fullPageIntervalMs", timing.fullPageIntervalMs);
  positive("timing.backoffBaseMs", timing.backoffBaseMs);
  positive("timing.backoffMaxMs", timing.backoffMaxMs);
  for (const name of ["unauthorizedDelayMs", "deadlineGraceMs", "maxRetryAfterMs"] as const) {
    if (typeof timing[name] !== "number" || !(timing[name] >= 0)) throw new RangeError(`timing.${name} must be 0 or more`);
  }
  if (!Number.isInteger(timing.maxCreateAttempts) || timing.maxCreateAttempts < 1) {
    throw new RangeError("timing.maxCreateAttempts must be a whole number, 1 or more");
  }
  if (typeof timing.random !== "function") throw new TypeError("timing.random must be a function");
  return timing;
}

function resolveLimits(partial: Partial<Limits> | undefined): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS, ...partial };
  for (const name of ["maxTrackedTasks", "maxUnclaimedResults", "maxRetainedResults"] as const) {
    if (!Number.isInteger(limits[name]) || limits[name] < 1) throw new RangeError(`limits.${name} must be a whole number, 1 or more`);
  }
  positive("limits.resultTtlMs", limits.resultTtlMs);
  return limits;
}

/** The base URL without a trailing slash. Plain http is only for loopback: the key must not cross a network in the clear. */
function resolveBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("baseUrl must be a URL such as https://tasks.getmailman.app");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must not contain credentials, a query or a fragment");
  }
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("baseUrl must use https (http is only accepted for localhost)");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
