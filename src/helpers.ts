import { InvalidRequestError } from "./errors.js";
import type { TaskInput } from "./types.js";

/** Fields every helper passes through to the task. */
interface TaskExtras {
  /** Seconds the task may run, 1 to 3600. Default: the client's 300. */
  timeout?: number;
  group?: string;
  /** Unix time in seconds. Default: when the task is created. */
  receivedAt?: number;
  templateId?: string;
}

export interface CodeTaskOptions extends TaskExtras {
  /** The address the email is sent to. */
  email: string;
  /** Text the sender must include: an address or a domain. */
  from: string;
  /** Text the subject must include. */
  subjectIncludes: string;
  /** Digits in the code. Default 6. */
  length?: number;
}

export interface LinkTaskOptions extends TaskExtras {
  email: string;
  from: string;
  subjectIncludes: string;
  /** Text the link's address must include, for example "/verify". */
  linkIncludes: string;
}

/**
 * A task that extracts a numeric code: the first standalone run of `length` digits in the email body.
 * The result is `results.code`.
 */
export function codeTask(options: CodeTaskOptions): TaskInput {
  const { email, from, subjectIncludes, length = 6, ...extras } = options;
  if (!Number.isInteger(length) || length < 1 || length > 32) {
    throw new InvalidRequestError("length must be a whole number from 1 to 32");
  }
  return {
    ...extras,
    email,
    mailFilters: [
      { target: "from", comparator: "includes", value: from },
      { target: "subject", comparator: "includes", value: subjectIncludes },
    ],
    // The regular expression \b\d{6}\b. JSON-encoding the task doubles the backslashes (rule M12).
    mailElements: [{ name: "code", target: "body", regex: `\\b\\d{${length}}\\b` }],
  };
}

/** A task that extracts a link: the address of the first body link whose href includes `linkIncludes`. The result is `results.loginUrl`. */
export function linkTask(options: LinkTaskOptions): TaskInput {
  const { email, from, subjectIncludes, linkIncludes, ...extras } = options;
  if (typeof linkIncludes !== "string" || linkIncludes === "") {
    throw new InvalidRequestError("linkIncludes is required");
  }
  return {
    ...extras,
    email,
    mailFilters: [
      { target: "from", comparator: "includes", value: from },
      { target: "subject", comparator: "includes", value: subjectIncludes },
    ],
    mailElements: [
      { name: "loginUrl", target: "body", selector: `a[href*='${cssString(linkIncludes)}']`, formatter: "link" },
    ],
  };
}

/** Escape text for the inside of a single-quoted CSS string. */
function cssString(value: string): string {
  return value.replace(/[\\'\n\r\f]/g, (char) => {
    switch (char) {
      case "\n":
        return "\\a ";
      case "\r":
        return "\\d ";
      case "\f":
        return "\\c ";
      default:
        return `\\${char}`;
    }
  });
}
