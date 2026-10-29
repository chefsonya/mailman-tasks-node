export { MailmanTasks } from "./client.js";
export { codeTask, linkTask } from "./helpers.js";
export type { CodeTaskOptions, LinkTaskOptions } from "./helpers.js";
export {
  AUTH_MESSAGE,
  AuthError,
  InvalidRequestError,
  MailmanError,
  NetworkError,
  PayloadTooLargeError,
  PendingLimitError,
  RateLimitError,
  RequestTimeoutError,
  ServerBusyError,
  TaskFailedError,
  TaskTimeoutError,
  TooManyTasksError,
} from "./errors.js";
export type { MailmanErrorInit, NetworkErrorInit, TaskTimeoutReason } from "./errors.js";
export type {
  ClientOptions,
  ClientStats,
  CreateOptions,
  DeadlineOptions,
  Limits,
  MailElement,
  MailFilter,
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
export { VERSION } from "./version.js";
