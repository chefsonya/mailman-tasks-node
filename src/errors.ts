/** What a bot should show when the API answers 401 (rule S8). */
export const AUTH_MESSAGE = "The key was rejected, or Mailman isn't open on your computer.";

export interface MailmanErrorInit {
  /** HTTP status; 0 when no HTTP response was involved. */
  status?: number;
  /** The `error` text of the server's `{"error": "..."}` body. */
  apiMessage?: string;
  /** Seconds from the Retry-After header, 0 if absent. */
  retryAfter?: number;
  cause?: unknown;
}

/** Base class of everything this package throws on purpose. */
export class MailmanError extends Error {
  /** HTTP status of the answer, or 0 when there was none (validation, transport, deadlines). */
  readonly status: number;
  /** The server's `{"error": "..."}` message, when the answer had one. */
  readonly apiMessage: string | undefined;
  /** Seconds from the Retry-After header; 0 if the answer had none. */
  readonly retryAfter: number;

  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    Object.defineProperty(this, "name", { value: new.target.name, enumerable: false, configurable: true });
    this.status = init.status ?? 0;
    this.apiMessage = init.apiMessage;
    this.retryAfter = init.retryAfter ?? 0;
  }
}

/** 401: the key was rejected, or the user's Mailman isn't open and connected. The API doesn't say which. */
export class AuthError extends MailmanError {
  constructor(init: MailmanErrorInit = {}) {
    super(AUTH_MESSAGE, { ...init, status: 401 });
  }
}

/** 400, or a task this package refused to send because the API would answer 400. Don't retry. */
export class InvalidRequestError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 400 });
  }
}

/** 413: the task is over 64 KiB. Don't retry. */
export class PayloadTooLargeError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 413 });
  }
}

/** 429 `rate limit exceeded`. `retryAfter` is the seconds until the window resets. */
export class RateLimitError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 429 });
  }
}

/** 429 `pending task limit exceeded`: the key has 10000 pending tasks. Collect results first. Not a RateLimitError, never retried. */
export class PendingLimitError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 429 });
  }
}

/** 503 `server busy` or `server shutting down`. */
export class ServerBusyError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 503 });
  }
}

/** 408: the server gave up on the request after 10 seconds. */
export class RequestTimeoutError extends MailmanError {
  constructor(message: string, init: MailmanErrorInit = {}) {
    super(message, { ...init, status: 408 });
  }
}

export interface NetworkErrorInit extends MailmanErrorInit {
  /** True when the failure was this client giving up on the request (its own timeout or deadline cap). */
  timedOut?: boolean;
  /** False only when the request provably never left this machine (the connection was refused, the name didn't resolve). */
  requestMayHaveBeenSent?: boolean;
}

/**
 * No HTTP answer arrived: connection refused, reset or dropped, a truncated body, or this client's own request timeout.
 * For `createTask` this is ambiguous: the task may exist. It is never retried automatically.
 */
export class NetworkError extends MailmanError {
  readonly timedOut: boolean;
  readonly requestMayHaveBeenSent: boolean;

  constructor(message: string, init: NetworkErrorInit = {}) {
    super(message, init);
    this.timedOut = init.timedOut ?? false;
    this.requestMayHaveBeenSent = init.requestMayHaveBeenSent ?? true;
  }
}

/** The client-side cap on tracked tasks is reached and every tracked task is still live. Nothing was sent. */
export class TooManyTasksError extends MailmanError {
  readonly limit: number;

  constructor(message: string, limit: number) {
    super(message);
    this.limit = limit;
  }
}

/** The task finished with `status: "error"`. */
export class TaskFailedError extends MailmanError {
  readonly taskId: string;
  /** `results.errorStatus`, for example `invalid mail task`. */
  readonly errorStatus: string;
  /** `results.errorMessage`. */
  readonly errorMessage: string;

  constructor(taskId: string, errorStatus: string, errorMessage: string) {
    super(`Task ${taskId} failed: ${errorStatus}${errorMessage ? `: ${errorMessage}` : ""}`);
    this.taskId = taskId;
    this.errorStatus = errorStatus;
    this.errorMessage = errorMessage;
  }
}

export type TaskTimeoutReason =
  /** The server completed the task as `timeout`: no matching email arrived in time. */
  | "timeout"
  /** The wait deadline passed without a result: the task is lost, create it again (rule M8). */
  | "deadline";

/**
 * No result in time. After `reason: "deadline"` the task is lost: trigger a fresh email and create it again.
 * `taskId` is undefined when the deadline passed before the task's creation was confirmed (it may exist).
 */
export class TaskTimeoutError extends MailmanError {
  readonly taskId: string | undefined;
  readonly group: string;
  readonly reason: TaskTimeoutReason;

  constructor(taskId: string | undefined, group: string, reason: TaskTimeoutReason, init: MailmanErrorInit = {}) {
    super(
      reason === "timeout"
        ? `Task ${taskId} timed out: no matching email arrived in time.`
        : taskId === undefined
          ? "The deadline passed before the task's creation was confirmed. It may exist: create it again if you still need it."
          : `Task ${taskId} is lost: no result by the deadline. Create it again.`,
      init,
    );
    this.taskId = taskId;
    this.group = group;
    this.reason = reason;
  }
}
