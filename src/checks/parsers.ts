/**
 * Turn raw check output into structured failures.
 *
 * Why parse at all instead of forwarding the text: a `tsc` run that reports
 * the same missing export in 40 files emits ~200 lines of which ~3 carry
 * information. Every one of those lines is paid for once as a cache write and
 * then re-read on every later request in the session. Structuring lets us
 * dedupe by (path, line, code) and cap the rest, which is a far bigger and
 * far safer reduction than truncating text.
 */

export interface Failure {
  /** Repo-relative when the tool reports one; otherwise whatever it printed. */
  path: string | null;
  line: number | null;
  column: number | null;
  /** Tool-specific identifier: TS2345, no-unused-vars, the assertion name. */
  code: string | null;
  message: string;
  /** How many identical (path, line, code, message) findings collapsed here. */
  count: number;
}

export type CheckKind = "tsc" | "eslint" | "vitest" | "pytest" | "generic";

export const CHECK_KINDS: readonly CheckKind[] = ["tsc", "eslint", "vitest", "pytest", "generic"];

function failure(partial: Partial<Failure> & { message: string }): Failure {
  return {
    path: partial.path ?? null,
    line: partial.line ?? null,
    column: partial.column ?? null,
    code: partial.code ?? null,
    message: partial.message.trim(),
    count: 1,
  };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip an absolute prefix so paths stay comparable across machines. */
function relativize(p: string, root: string): string {
  const posixPath = toPosix(p);
  const posixRoot = toPosix(root).replace(/\/+$/, "");
  if (posixRoot !== "" && posixPath.toLowerCase().startsWith(`${posixRoot.toLowerCase()}/`)) {
    return posixPath.slice(posixRoot.length + 1);
  }
  return posixPath;
}

/**
 * Pull the outermost JSON value out of mixed output. Reporters routinely
 * interleave their JSON with warnings on the same stream, so a bare
 * JSON.parse of the whole buffer fails on perfectly good runs.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to bracket scanning
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // try the other bracket kind
      }
    }
  }
  return null;
}

/** `src/a.ts(42,18): error TS2345: Argument of type ...` */
function parseTsc(text: string, root: string): Failure[] {
  const out: Failure[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
  for (const line of text.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match === null) continue;
    out.push(
      failure({
        path: relativize(match[1] as string, root),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[5] as string,
        message: match[6] as string,
      })
    );
  }
  // `error TSxxxx:` without a file (config errors) still matters.
  if (out.length === 0) {
    for (const line of text.split("\n")) {
      const match = /^\s*error\s+(TS\d+):\s*(.*)$/.exec(line);
      if (match !== null) out.push(failure({ code: match[1] as string, message: match[2] as string }));
    }
  }
  return out;
}

/** `eslint --format json`: [{ filePath, messages: [{ ruleId, line, column, message, severity }] }] */
function parseEslint(text: string, root: string): Failure[] {
  const parsed = extractJson(text);
  if (!Array.isArray(parsed)) return [];
  const out: Failure[] = [];
  for (const file of parsed) {
    if (file === null || typeof file !== "object") continue;
    const record = file as Record<string, unknown>;
    const filePath = typeof record.filePath === "string" ? relativize(record.filePath, root) : null;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      // severity 1 is a warning; only errors gate.
      if (message.severity !== 2) continue;
      out.push(
        failure({
          path: filePath,
          line: typeof message.line === "number" ? message.line : null,
          column: typeof message.column === "number" ? message.column : null,
          code: typeof message.ruleId === "string" ? message.ruleId : null,
          message: typeof message.message === "string" ? message.message : "eslint error",
        })
      );
    }
  }
  return out;
}

/** `vitest --reporter=json`: { testResults: [{ name, assertionResults: [...] }] } */
function parseVitest(text: string, root: string): Failure[] {
  const parsed = extractJson(text);
  if (parsed === null || typeof parsed !== "object") return [];
  const suites = (parsed as Record<string, unknown>).testResults;
  if (!Array.isArray(suites)) return [];

  const out: Failure[] = [];
  for (const suite of suites) {
    if (suite === null || typeof suite !== "object") continue;
    const record = suite as Record<string, unknown>;
    const file = typeof record.name === "string" ? relativize(record.name, root) : null;

    const assertions = Array.isArray(record.assertionResults) ? record.assertionResults : [];
    for (const raw of assertions) {
      if (raw === null || typeof raw !== "object") continue;
      const assertion = raw as Record<string, unknown>;
      if (assertion.status !== "failed") continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      const first = messages.find((m): m is string => typeof m === "string") ?? "test failed";
      out.push(
        failure({
          path: file,
          // The first stack frame pointing back into the test file is the line
          // a human would jump to.
          line: firstLineIn(first, file),
          code: typeof assertion.fullName === "string" ? assertion.fullName : null,
          message: firstMeaningfulLine(first),
        })
      );
    }

    // A suite that failed to even load reports no assertions, only a message.
    if (assertions.length === 0 && typeof record.message === "string" && record.message.trim() !== "") {
      out.push({ ...failure({ path: file, message: firstMeaningfulLine(record.message) }), code: "suite-error" });
    }
  }
  return out;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") return line.trim();
  }
  return text.trim();
}

function firstLineIn(stack: string, file: string | null): number | null {
  if (file === null) return null;
  const base = file.split("/").pop();
  if (base === undefined) return null;
  const match = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):`).exec(stack);
  return match === null ? null : Number(match[1]);
}

/** pytest short summary: `FAILED tests/test_a.py::test_x - AssertionError: ...` */
function parsePytest(text: string, root: string): Failure[] {
  const out: Failure[] = [];
  for (const line of text.split("\n")) {
    const summary = /^(FAILED|ERROR)\s+(\S+?)(::(\S+))?\s*(-\s*(.*))?$/.exec(line.trim());
    if (summary !== null) {
      out.push(
        failure({
          path: relativize(summary[2] as string, root),
          code: summary[4] ?? null,
          message: summary[6] ?? (summary[1] as string),
        })
      );
      continue;
    }
    // `path/to/file.py:42: AssertionError` — the location form.
    const located = /^(.+\.py):(\d+):\s*(.*)$/.exec(line.trim());
    if (located !== null) {
      out.push(
        failure({
          path: relativize(located[1] as string, root),
          line: Number(located[2]),
          message: located[3] as string,
        })
      );
    }
  }
  return out;
}

/**
 * Unknown tool: keep lines that look like failures, so even an unparsed check
 * returns something better than a wall of text.
 */
const GENERIC_FAILURE =
  /(^|\b)(error|fatal|fail|failed|failure|exception|traceback|panic|assert\w*|\w*Error)\b|^\s*at\s+\S+\s*\(/i;

function parseGeneric(text: string, root: string): Failure[] {
  const out: Failure[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !GENERIC_FAILURE.test(trimmed)) continue;
    // Best-effort location: `path:line:col` or `path:line`.
    const located = /^([\w./\\-]+\.\w+):(\d+)(?::(\d+))?[:\s]/.exec(trimmed);
    out.push(
      failure({
        path: located !== null ? relativize(located[1] as string, root) : null,
        line: located !== null ? Number(located[2]) : null,
        column: located?.[3] !== undefined ? Number(located[3]) : null,
        message: trimmed,
      })
    );
  }
  return out;
}

export function parseFailures(kind: CheckKind, stdout: string, stderr: string, root: string): Failure[] {
  const combined = stderr.trim() === "" ? stdout : `${stdout}\n${stderr}`;
  switch (kind) {
    case "tsc":
      return parseTsc(combined, root);
    case "eslint":
      // eslint writes its JSON to stdout; stderr carries crash output only.
      return parseEslint(stdout, root).concat(stdout.trim() === "" ? parseGeneric(stderr, root) : []);
    case "vitest":
      return parseVitest(stdout, root);
    case "pytest":
      return parsePytest(combined, root);
    default:
      return parseGeneric(combined, root);
  }
}

/**
 * Collapse findings that are identical in all four of path, line, code and
 * message into one entry, summing their `count`.
 *
 * Only exact duplicates merge. Two findings sharing a code and message at
 * DIFFERENT locations stay separate entries, because the key includes the
 * location — a failure the reader has to be able to go to is not one the reader
 * can be told about in aggregate.
 */
export function dedupe(failures: Failure[]): Failure[] {
  const exact = new Map<string, Failure>();
  for (const item of failures) {
    const key = `${item.path}:${item.line}:${item.code}:${item.message}`;
    const seen = exact.get(key);
    if (seen === undefined) exact.set(key, { ...item });
    else seen.count += item.count;
  }
  return [...exact.values()];
}
