export interface MailFilter {
  /** What to compare. For "from" the sender is "Name <address>" when the email has a display name. */
  target: "from" | "subject";
  /** `findByRegex` means `matches`. */
  comparator: "includes" | "excludes" | "matches" | "findByRegex";
  /** Text or pattern. Not empty, at most 1024 characters. */
  value: string;
  /** Up to 10 alternatives: the filter passes if `value` or any entry passes. */
  orValues?: string[];
  /** Optional filters aren't required to match. */
  optional?: boolean;
  /** A regular expression whose matches are removed from the target before comparing. */
  regexReplaceAll?: string;
}

export interface MailElement {
  /** The key this value gets in `results`. Not empty. */
  name: string;
  target: "from" | "subject" | "body";
  /** Body only: a CSS selector (XPath when it starts with "/", "./" or "("). A body element needs a selector or a regex. */
  selector?: string;
  /** Applied to the value. Group 1 is the value when the pattern has a capture group, otherwise the whole match. */
  regex?: string;
  /** Body element with a regex and no selector: "pretty" (default) runs on the readable text, "raw" on the HTML. */
  regexSource?: "pretty" | "raw";
  /** How a selector match becomes a value. Default "text". */
  formatter?: "text" | "html" | "link" | "numeric";
  /** Accepted for AYCD compatibility and ignored. */
  penetrate?: boolean;
}

/** A mail task as you hand it to `createTask` / `run`. */
export interface TaskInput {
  /** The address the email is sent to. Required, at most 1024 characters. */
  email: string;
  /** 1 to 10 filters that pick the email. */
  mailFilters: MailFilter[];
  /** 1 to 10 values to extract from it. */
  mailElements: MailElement[];
  /** Unix time in SECONDS (not `Date.now()`). Only mail received at or after it can answer. Default: now. */
  receivedAt?: number;
  /** Seconds the task may run, 1 to 3600. Default: 300 (the API itself defaults to 3600). */
  timeout?: number;
  /** Tasks that are polled together. Default: the client's group. `wait` polls the same group. */
  group?: string;
  /** A task template the user created in Mailman. Omit unless the user set one up. */
  templateId?: string;
}

export type TaskStatus = "success" | "error" | "timeout";

/** One entry of `GET /completed`. */
export interface TaskResult {
  id: string;
  status: TaskStatus;
  /** success: element name to extracted text, `{}` when nothing was extracted. error: `errorStatus` and `errorMessage`. timeout: absent. */
  results?: Record<string, string>;
}

export interface SuccessResult extends TaskResult {
  status: "success";
  results: Record<string, string>;
}

/**
 * When a wait gives up. Give at most one of the two; the earlier wins when both are set. The deadline, like the
 * `signal`, ends the call and nothing more: a poll that is already in flight is never cut by it, because the server
 * deletes the results as it writes the answer. The poll finishes in the background and its results are stored.
 */
export interface DeadlineOptions {
  /** Give up this many milliseconds from now. */
  timeoutMs?: number;
  /** Give up at this wall-clock time (a Date or epoch milliseconds). Measured on a monotonic clock from the moment of the call. */
  deadline?: number | Date;
  /** Abort the call. A task that was already created stays on the server. */
  signal?: AbortSignal;
}

export interface WaitOptions extends DeadlineOptions {
  /**
   * The group to poll. Only for a task id this client didn't create: for its own tasks the group
   * recorded at creation is used, and a different value is an error.
   */
  group?: string;
}

export type RunOptions = DeadlineOptions;

export interface CreateOptions {
  /** Abort the call, including while it sleeps between retries. If it fires during the POST the task may exist. */
  signal?: AbortSignal;
}

export interface PollOptions {
  /**
   * Ends the call, and cancels it for good while it still waits for its turn. A request that is already out is not cut
   * by it: it finishes in the background and its results are stored for later `wait`s. Only `close()` cuts it.
   */
  signal?: AbortSignal;
  /**
   * Total timeout of this poll's request: connecting, the headers and the whole body. Default: the client's
   * `requestTimeoutMs`. A request that times out loses what it was carrying, so don't make this short.
   */
  timeoutMs?: number;
}

export interface VerifyOptions {
  signal?: AbortSignal;
}

/**
 * The pace the API asks for, and this client's retry schedule. Defaults are the API's rules (M5, M9, M11).
 * Lower them only for tests against a mock server: below these values the hosted API rate-limits you.
 */
export interface Timing {
  /** Minimum gap between two polls of one group. Default 3000. */
  pollIntervalMs: number;
  /** The gap right after a full page of 100 results. Default 1000. */
  fullPageIntervalMs: number;
  /** The gap after a 401, until the user's Mailman is connected again. Default 10000. */
  unauthorizedDelayMs: number;
  /** First backoff step; doubles per consecutive failure. Default 1000. */
  backoffBaseMs: number;
  /** Largest backoff step. Default 30000. */
  backoffMaxMs: number;
  /** Added to a task's timeout to get its wait deadline. Default 15000. */
  deadlineGraceMs: number;
  /** Attempts for `createTask` (and `verify`), the first one included. Default 3. */
  maxCreateAttempts: number;
  /** A Retry-After above this makes `createTask` give up instead of sleeping. Default 60000. */
  maxRetryAfterMs: number;
  /** Jitter source, `Math.random` by default. */
  random: () => number;
}

export interface Limits {
  /**
   * Live tasks tracked at once: pending, or with a result nobody has taken yet. A create over this is
   * refused before it is sent. Results already handed out don't count. Default 50000.
   */
  maxTrackedTasks: number;
  /** Results nobody has taken yet, of tasks this client didn't create. The oldest go first. Default 10000. */
  maxUnclaimedResults: number;
  /** Results already handed out that are kept for repeat `wait` calls. The oldest go first. Default 10000. */
  maxRetainedResults: number;
  /** How long a result is kept after it arrived, delivered or not. Default 3600000 (1 hour). */
  resultTtlMs: number;
}

export interface ClientOptions {
  /** The group tasks are created in and waited on by default. Default "default". */
  group?: string;
  /** Default `https://tasks.getmailman.app`. For tests and advanced use only. */
  baseUrl?: string;
  /**
   * Total timeout of every HTTP request, in milliseconds, counted from the moment it starts and covering the connection,
   * the headers and the whole body (a body that trickles in is cut too). It is the only thing that bounds a poll in
   * flight, besides `close()`. Default 15000.
   */
  requestTimeoutMs?: number;
  /**
   * A `fetch` to send requests with, for tests. The default is Node's own `http`/`https`: one request per
   * connection, no redirects and no automatic replay. A `fetch` you pass is used as it is: Node's global one,
   * for example, re-sends a request once after a 421, outside this client's pacing, and its sockets keep the
   * process alive while a poll nobody waits for any more is still in flight.
   */
  fetch?: typeof fetch;
  /** Default `mailman-tasks-node/<version>`. */
  userAgent?: string;
  /** See {@link Timing}. */
  timing?: Partial<Timing>;
  /** See {@link Limits}. */
  limits?: Partial<Limits>;
}

/** A snapshot of what the client is holding, for diagnostics and tests. */
export interface ClientStats {
  /** Tasks created by this client that are pending, awaited, or have a stored result (or expired and not reclaimed yet). */
  trackedTasks: number;
  /** Groups with live bookkeeping. */
  groups: number;
  /** Running polling loops. */
  pollers: number;
  /** `wait` calls in progress. */
  waiters: number;
  /** Results received that no `wait` or `poll()` has handed out yet. */
  bufferedResults: number;
  /** Results already handed out and kept for repeat reads, until they expire. */
  retainedResults: number;
}
