/**
 * The 20 tasks of corpus #1, and the reason they look like this.
 *
 * B6 counts mechanical failures: type errors, failing assertions, lint
 * violations, missing imports. Two constraints shape what is possible here.
 *
 * WHY SYNTHETIC. The obvious real source is this repo's own history, and it does
 * not carry these: all 17 `fix:` commits that touch src/ and tests/ insert
 * 17-368 lines and every subject describes a reasoning error, not a mechanical
 * one. Reverting one produces a design task wearing a red gate. The other real
 * source, captured failures, did not exist until the commit before this one --
 * `gate` parsed a typed Failure[] on every red run and dropped it. So this
 * distribution is CHOSEN, and B6's record has to say so on the same line as the
 * number. Corpus #2, from the capture hook, is the one that measures instead.
 *
 * WHY NO LINT. This repo configures two checks, tsc and npm-test, and no
 * linter, so B6's fourth category cannot be exercised in this venue at all.
 * Same shape as B5's finding, and for the same reason: the repo, not the tool.
 *
 * WHY ONE TASK ON DISK AT A TIME. Twenty broken fixtures at once would make
 * every task's gate output carry the other nineteen's failures, and `repair`
 * loops until the gate is GREEN -- which, with nineteen other files broken, is
 * never. Every task would return max_rounds and B6's close rate would be 0/20
 * by construction rather than by measurement. So the runner installs one and
 * removes it before the next.
 */

const MARKER = "// Fixture for corpus-run.sh. Removed by the `restore` subcommand.";
const SRC = "src/corpus-fixture.ts";
const TEST = "tests/corpus-fixture.test.ts";

/** A source file whose ONLY error is the one named, so the task is the task. */
const src = (body) => `${MARKER}\n${body}`;

/**
 * Assertion tasks need a test that is CORRECT and a source that is wrong. If the
 * test were wrong too, a model could satisfy it by breaking the source further,
 * and the gate would call that a pass.
 */
const test = (body) =>
  `${MARKER}\nimport { describe, expect, it } from "vitest";\n\n` +
  `import { subject } from "../src/corpus-fixture.js";\n\n${body}`;

export const TASKS = [
  // ---------------------------------------------------------- type errors (8)
  {
    id: "type-01-wrong-operand",
    category: "type",
    checks: "types",
    src: src(`export function twice(n: number): number {\n  return n * "2";\n}\n`),
    spec: "twice must return n multiplied by 2, with no type errors.",
  },
  {
    id: "type-02-wrong-arity",
    category: "type",
    checks: "types",
    src: src(
      `function add(a: number, b: number): number {\n  return a + b;\n}\n\n` +
        `export function total(xs: number[]): number {\n  return xs.reduce((acc, x) => add(acc), 0);\n}\n`
    ),
    spec: "total must sum the array using add, which takes two arguments.",
  },
  {
    id: "type-03-missing-property",
    category: "type",
    checks: "types",
    src: src(
      `export interface Point {\n  x: number;\n  y: number;\n}\n\n` +
        `export function origin(): Point {\n  return { x: 0 };\n}\n`
    ),
    spec: "origin must return a complete Point at the origin.",
  },
  {
    id: "type-04-wrong-return-type",
    category: "type",
    checks: "types",
    src: src(`export function count(items: string[]): number {\n  return items.join(",");\n}\n`),
    spec: "count must return how many items there are.",
  },
  {
    id: "type-05-possibly-undefined",
    category: "type",
    checks: "types",
    src: src(
      `export function firstLength(items: string[]): number {\n  const head = items[0];\n  return head.length;\n}\n`
    ),
    spec: "firstLength must return the length of the first item, or 0 when the array is empty.",
  },
  {
    id: "type-06-wrong-argument-type",
    category: "type",
    checks: "types",
    src: src(
      `function repeat(text: string, times: number): string {\n  return text.repeat(times);\n}\n\n` +
        `export function shout(text: string): string {\n  return repeat(text, "3");\n}\n`
    ),
    spec: "shout must repeat the text three times.",
  },
  {
    id: "type-07-excess-property",
    category: "type",
    checks: "types",
    src: src(
      `export interface Options {\n  retries: number;\n}\n\n` +
        `export function defaults(): Options {\n  return { retries: 3, verbose: true };\n}\n`
    ),
    spec: "defaults must return valid Options with three retries. Do not add fields to the interface.",
  },
  {
    id: "type-08-null-not-handled",
    category: "type",
    checks: "types",
    src: src(
      `export function upper(text: string | null): string {\n  return text.toUpperCase();\n}\n`
    ),
    spec: "upper must uppercase the text, returning an empty string when it is null.",
  },

  // ------------------------------------------------------- missing imports (4)
  {
    id: "import-01-missing-node-builtin",
    category: "import",
    checks: "types",
    src: src(
      `export function under(root: string, name: string): string {\n  return path.join(root, name);\n}\n`
    ),
    spec: "under must join the two segments with Node's path module.",
  },
  {
    id: "import-02-unknown-name",
    category: "import",
    checks: "types",
    src: src(
      `export function digest(text: string): string {\n` +
        `  return createHash("sha256").update(text).digest("hex");\n}\n`
    ),
    spec: "digest must return the hex sha256 of the text, using Node's crypto module.",
  },
  {
    id: "import-03-missing-local-type",
    category: "import",
    checks: "types",
    src: src(
      `export function describeFailure(f: Failure): string {\n` +
        `  return f.path === null ? f.message : \`\${f.path}: \${f.message}\`;\n}\n`
    ),
    spec:
      "describeFailure must take a Failure from src/checks/parsers.ts. Import the type; do not redefine it.",
  },
  {
    id: "import-04-nonexistent-module",
    category: "import",
    checks: "types",
    src: src(
      `import { readFileSync } from "node:filesystem";\n\n` +
        `export function readText(p: string): string {\n  return readFileSync(p, "utf8");\n}\n`
    ),
    spec: "readText must read a UTF-8 file synchronously from the correct Node module.",
  },

  // ---------------------------------------------------- failing assertions (8)
  {
    id: "assert-01-wrong-operator",
    category: "assert",
    checks: "test",
    src: src(`export function subject(a: number, b: number): number {\n  return a - b;\n}\n`),
    test: test(
      `describe("subject", () => {\n  it("adds", () => {\n    expect(subject(2, 3)).toBe(5);\n  });\n});\n`
    ),
    spec: "subject must add its two arguments so the existing test passes. Do not edit the test.",
  },
  {
    id: "assert-02-off-by-one",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(n: number): number[] {\n` +
        `  const out: number[] = [];\n  for (let i = 1; i < n; i++) out.push(i);\n  return out;\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("counts from 1 to n inclusive", () => {\n` +
        `    expect(subject(3)).toEqual([1, 2, 3]);\n  });\n});\n`
    ),
    spec: "subject must return 1..n inclusive so the existing test passes. Do not edit the test.",
  },
  {
    id: "assert-03-wrong-shape",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(text: string): string[] {\n  return text.split(",");\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("trims each field", () => {\n` +
        `    expect(subject("a, b ,c")).toEqual(["a", "b", "c"]);\n  });\n});\n`
    ),
    spec: "subject must split on commas and trim each field. Do not edit the test.",
  },
  {
    id: "assert-04-wrong-empty-case",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(items: string[]): string {\n  return items.join(" and ");\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("joins with and", () => {\n` +
        `    expect(subject(["a", "b"])).toBe("a and b");\n  });\n\n` +
        `  it("says none when empty", () => {\n    expect(subject([])).toBe("none");\n  });\n});\n`
    ),
    spec: 'subject must join with " and ", and return "none" for an empty list. Do not edit the test.',
  },
  {
    id: "assert-05-wrong-rounding",
    category: "assert",
    checks: "test",
    src: src(`export function subject(n: number): number {\n  return Math.floor(n);\n}\n`),
    test: test(
      `describe("subject", () => {\n  it("rounds half up", () => {\n` +
        `    expect(subject(2.5)).toBe(3);\n    expect(subject(2.4)).toBe(2);\n  });\n});\n`
    ),
    spec: "subject must round to the nearest integer, halves up. Do not edit the test.",
  },
  {
    id: "assert-06-wrong-order",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(items: number[]): number[] {\n  return [...items].sort();\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("sorts numerically", () => {\n` +
        `    expect(subject([10, 9, 100])).toEqual([9, 10, 100]);\n  });\n});\n`
    ),
    spec: "subject must sort numerically, not lexicographically. Do not edit the test.",
  },
  {
    id: "assert-07-missing-guard",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(a: number, b: number): number {\n  return a / b;\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("divides", () => {\n    expect(subject(6, 3)).toBe(2);\n  });\n\n` +
        `  it("returns 0 rather than Infinity", () => {\n    expect(subject(6, 0)).toBe(0);\n  });\n});\n`
    ),
    spec: "subject must divide, returning 0 when the divisor is 0. Do not edit the test.",
  },
  {
    id: "assert-08-wrong-case-handling",
    category: "assert",
    checks: "test",
    src: src(
      `export function subject(items: string[], needle: string): boolean {\n` +
        `  return items.includes(needle);\n}\n`
    ),
    test: test(
      `describe("subject", () => {\n  it("matches case-insensitively", () => {\n` +
        `    expect(subject(["Alpha", "Beta"], "alpha")).toBe(true);\n` +
        `    expect(subject(["Alpha"], "gamma")).toBe(false);\n  });\n});\n`
    ),
    spec: "subject must match case-insensitively. Do not edit the test.",
  },
];

export { MARKER, SRC, TEST };

// --------------------------------------------------------------------- CLI
//
// Driven by corpus-run.sh. Kept in this file so the fixture text and the code
// that installs it cannot drift apart into two versions of "task 7".

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Deletes ONLY files whose first line carries this script's marker. A cleanup
 * step that deletes on the strength of a filename alone is how a corpus run
 * destroys work it was never asked to touch.
 */
function removeInstalled(root) {
  const removed = [];
  const refused = [];
  for (const rel of [SRC, TEST]) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const first = readFileSync(abs, "utf8").split("\n")[0] ?? "";
    if (first.includes("corpus-run.sh")) {
      rmSync(abs);
      removed.push(rel);
    } else {
      refused.push(rel);
    }
  }
  return { removed, refused };
}

function install(root, index) {
  const task = TASKS[index - 1];
  if (task === undefined) throw new Error(`no task ${index}; there are ${TASKS.length}`);
  const { refused } = removeInstalled(root);
  if (refused.length > 0) {
    throw new Error(`refusing to overwrite files this script did not write: ${refused.join(", ")}`);
  }
  for (const rel of [SRC, TEST]) {
    if (existsSync(path.join(root, rel))) {
      throw new Error(`${rel} still exists after cleanup; not overwriting it`);
    }
  }
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, SRC), task.src, "utf8");
  if (task.test !== undefined) writeFileSync(path.join(root, TEST), task.test, "utf8");
  return task;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [command, arg] = process.argv.slice(2);
  const root = process.env.CORPUS_ROOT ?? process.cwd();
  try {
    if (command === "count") {
      console.log(String(TASKS.length));
    } else if (command === "install") {
      const task = install(root, Number(arg));
      // The runner prints these verbatim into the prompt, so the shell never
      // has to know what a task looks like.
      console.log(JSON.stringify({ id: task.id, category: task.category, checks: task.checks, spec: task.spec, files: [SRC] }));
    } else if (command === "remove") {
      const { removed, refused } = removeInstalled(root);
      console.log(JSON.stringify({ removed, refused }));
      if (refused.length > 0) process.exit(1);
    } else if (command === "ids") {
      console.log(TASKS.map((t, i) => `${i + 1}\t${t.category}\t${t.id}`).join("\n"));
    } else {
      console.error("usage: corpus-fixtures.mjs {count|ids|install N|remove}");
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
