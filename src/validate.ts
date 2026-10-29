import { InvalidRequestError, PayloadTooLargeError } from "./errors.js";
import type { Redactor } from "./redact.js";
import type { TaskInput } from "./types.js";

// These mirror the API's own task checks: a task that fails here would be answered 400 by the API.
export const MAX_FIELD_CHARS = 1024;
export const MAX_FILTERS = 10;
export const MAX_ELEMENTS = 10;
export const MAX_OR_VALUES = 10;
export const MAX_TIMEOUT_SECS = 3600;
/** The API reads at most 64 KiB of request body (413 above). */
export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TASK_TIMEOUT_SECS = 300;
/** Seconds this large are in the year 5138; a real `receivedAt` in milliseconds is always above it. */
const MILLISECONDS_GUARD = 1e11;

const FILTER_TARGETS = ["from", "subject"];
const COMPARATORS = ["includes", "excludes", "matches", "findByRegex"];
const ELEMENT_TARGETS = ["from", "subject", "body"];
const REGEX_SOURCES = ["pretty", "raw"];
const FORMATTERS = ["text", "html", "link", "numeric"];

/** A task checked and normalised, ready to send. */
export interface PreparedTask {
  /** The group the task is created in, and the one its wait polls. */
  group: string;
  /** The timeout the API will apply, in seconds (0 and values above 3600 mean 3600). */
  timeoutSecs: number;
  /** The JSON request body. */
  json: string;
}

export interface PrepareContext {
  defaultGroup: string;
  /** Unix time in seconds, used when the task has no `receivedAt`. */
  nowSeconds: number;
  redact: Redactor;
}

type Obj = Record<string, unknown>;

/** Characters as the API counts them: Unicode scalar values, not UTF-16 units. */
export function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

class Checker {
  constructor(private readonly redact: Redactor) {}

  fail(message: string): never {
    throw new InvalidRequestError(this.redact(message));
  }

  /** A string of at most 1024 characters. An absent optional field gives "". */
  string(obj: Obj, key: string, path: string): string {
    const value = obj[key];
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") return this.fail(`${path} must be a string`);
    this.text(path, value);
    return value;
  }

  text(path: string, value: string): void {
    if (codePointLength(value) > MAX_FIELD_CHARS) this.fail(`${path} exceeds ${MAX_FIELD_CHARS} characters`);
    if (!isWellFormed(value)) this.fail(`${path} must be valid Unicode text`);
  }

  oneOf(path: string, value: string, allowed: readonly string[]): void {
    if (!allowed.includes(value)) this.fail(`${path} has invalid value ${JSON.stringify(value)}`);
  }

  boolean(obj: Obj, key: string, path: string): void {
    const value = obj[key];
    if (value !== undefined && value !== null && typeof value !== "boolean") this.fail(`${path} must be true or false`);
  }
}

/** The group of a `poll` or `wait` call: the same rules as the group of a task. */
export function checkGroup(group: unknown, redact: Redactor): string {
  const check: Checker = new Checker(redact);
  if (typeof group !== "string") return check.fail("group must be a string");
  check.text("group", group);
  return group;
}

function checkFilter(check: Checker, filter: unknown, i: number): void {
  const path = (name: string) => `mailFilters[${i}].${name}`;
  if (!isObject(filter)) return check.fail(`mailFilters[${i}] must be an object`);
  const target = check.string(filter, "target", path("target"));
  const comparator = check.string(filter, "comparator", path("comparator"));
  const value = check.string(filter, "value", path("value"));
  check.string(filter, "regexReplaceAll", path("regexReplaceAll"));
  check.boolean(filter, "optional", path("optional"));
  const orValues = filter.orValues;
  if (orValues !== undefined && orValues !== null) {
    if (!Array.isArray(orValues) || orValues.some((v) => typeof v !== "string")) {
      return check.fail(`${path("orValues")} must be a list of strings`);
    }
    if (orValues.length > MAX_OR_VALUES) return check.fail("orValues has too many entries");
    for (const v of orValues as string[]) check.text(path("orValues"), v);
  }
  check.oneOf(path("target"), target, FILTER_TARGETS);
  check.oneOf(path("comparator"), comparator, COMPARATORS);
  if (value === "") return check.fail("mailFilters[].value is required");
}

function checkElement(check: Checker, element: unknown, i: number): void {
  const path = (name: string) => `mailElements[${i}].${name}`;
  if (!isObject(element)) return check.fail(`mailElements[${i}] must be an object`);
  const name = check.string(element, "name", path("name"));
  const target = check.string(element, "target", path("target"));
  const selector = check.string(element, "selector", path("selector"));
  const regex = check.string(element, "regex", path("regex"));
  const regexSource = check.string(element, "regexSource", path("regexSource"));
  const formatter = check.string(element, "formatter", path("formatter"));
  check.boolean(element, "penetrate", path("penetrate"));
  if (name === "") return check.fail("mailElements[].name is required");
  check.oneOf(path("target"), target, ELEMENT_TARGETS);
  if (target === "body" && selector === "" && regex === "") {
    return check.fail("mailElements[].selector or regex is required");
  }
  if (regexSource !== "") check.oneOf(path("regexSource"), regexSource, REGEX_SOURCES);
  if (formatter !== "") check.oneOf(path("formatter"), formatter, FORMATTERS);
}

/** Validate like the API does, fill in the defaults, and serialise. Throws InvalidRequestError or PayloadTooLargeError. */
export function prepareTask(task: TaskInput, context: PrepareContext): PreparedTask {
  const check: Checker = new Checker(context.redact);
  if (!isObject(task)) return check.fail("task must be an object");
  const input = task as unknown as Obj;

  const group = input.group === undefined || input.group === null ? context.defaultGroup : input.group;
  if (typeof group !== "string") return check.fail("group must be a string");
  check.text("group", group);
  check.string(input, "templateId", "templateId");

  const email = check.string(input, "email", "email");
  if (email.trim() === "") return check.fail("email is required");

  let receivedAt = input.receivedAt;
  if (receivedAt === undefined || receivedAt === null) receivedAt = context.nowSeconds;
  if (typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt)) {
    return check.fail("receivedAt must be a whole number of seconds since 1970 (Math.floor(Date.now() / 1000))");
  }
  if (receivedAt <= 0) return check.fail("receivedAt is required");
  if (receivedAt >= MILLISECONDS_GUARD) {
    return check.fail("receivedAt is in seconds, not milliseconds: divide Date.now() by 1000");
  }

  const filters = input.mailFilters;
  if (!Array.isArray(filters) || filters.length === 0) return check.fail("mailFilters is required");
  if (filters.length > MAX_FILTERS) return check.fail("mailFilters has too many entries");
  const elements = input.mailElements;
  if (!Array.isArray(elements) || elements.length === 0) return check.fail("mailElements is required");
  if (elements.length > MAX_ELEMENTS) return check.fail("mailElements has too many entries");

  for (const [i, filter] of (filters as unknown[]).entries()) checkFilter(check, filter, i);
  for (const [i, element] of (elements as unknown[]).entries()) checkElement(check, element, i);

  let timeout = input.timeout;
  if (timeout === undefined || timeout === null) timeout = DEFAULT_TASK_TIMEOUT_SECS;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0) {
    return check.fail("timeout must be a whole number of seconds");
  }
  // The API turns 0 and anything above 3600 into 3600. Say so, so the wait deadline matches.
  const timeoutSecs = timeout === 0 || timeout > MAX_TIMEOUT_SECS ? MAX_TIMEOUT_SECS : timeout;

  const body = { ...input, group, receivedAt, timeout: timeoutSecs };
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError(`The task is ${bytes} bytes; the API accepts at most ${MAX_BODY_BYTES} (64 KiB).`);
  }
  return { group, timeoutSecs, json };
}
