export type Redactor = (text: string) => string;

const REDACTED = "[redacted]";
// The API requires keys of 32+ characters. Shorter secrets would mangle ordinary words.
const MIN_REDACTED_LENGTH = 8;

/** A function that removes every form of `secret` (raw, JSON-escaped, URL-encoded) from a string. */
export function makeRedactor(secret: string): Redactor {
  const forms = new Set<string>();
  if (secret.length >= MIN_REDACTED_LENGTH) {
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
    forms.add(encodeURIComponent(secret));
  }
  // Longest first, so a form that contains another is replaced whole.
  const list = [...forms].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const form of list) if (out.includes(form)) out = out.split(form).join(REDACTED);
    return out;
  };
}

/**
 * A copy of a foreign error (from fetch, say) that is safe to attach as `cause`:
 * redacted messages, no foreign objects. Keeps the name, code and a short cause chain.
 */
export function sanitizeCause(error: unknown, redact: Redactor, depth = 0): unknown {
  if (error === undefined || error === null) return undefined;
  if (typeof error !== "object") return redact(String(error));
  const source = error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const copy = new Error(redact(typeof source.message === "string" ? source.message : String(error)));
  if (typeof source.name === "string") Object.defineProperty(copy, "name", { value: source.name, configurable: true });
  if (typeof source.code === "string" || typeof source.code === "number") {
    Object.defineProperty(copy, "code", { value: source.code, enumerable: true, configurable: true });
  }
  if (source.cause !== undefined && depth < 3) {
    Object.defineProperty(copy, "cause", {
      value: sanitizeCause(source.cause, redact, depth + 1),
      configurable: true,
    });
  }
  return copy;
}
