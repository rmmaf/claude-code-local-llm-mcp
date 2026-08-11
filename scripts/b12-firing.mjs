/**
 * The mutation harness's EVALUATOR — pure, no IO, no clock, no randomness.
 *
 * Clause 6 requires six negative controls SHOWN FIRING. The audit computer
 * checks that they are PASSING, which is strictly weaker: a gutted control that
 * keeps its title and asserts nothing passes. This module decides the stronger
 * question — did control C fail BECAUSE mutation M broke its subject — from
 * nothing but a vitest `--reporter=json` payload and the control file's text.
 *
 * It is separated from the runner (`b12-mutate.mjs`) for one reason: R38#5.
 * A harness whose verdict logic can only be exercised by running the real thing
 * cannot be tested for an INVERTED verdict, and an inverted verdict certifies
 * six broken controls. Everything here takes data and returns data, so the
 * self-test can push hand-built and probe-captured payloads through the SAME
 * functions the six controls travel.
 *
 * Every rule below about what vitest emits was MEASURED, not assumed — see
 * `docs/b12-scorer/MUTATION-HARNESS-PLAN.md` §2. Two of revision 2's guesses
 * died in that probe.
 */

/** Openings that end the previous declaration's line range. */
const BOUNDARY_RE = /^\s*(?:\/\/\s*)?(it|test|describe|beforeEach|beforeAll|afterEach|afterAll)\s*(?:\.\w+)?\s*\(/;

/** The four that own a range a test's assertion must NOT be found in. */
const HOOK_KINDS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);

/**
 * Every declaration boundary in a test file, with the line range it owns.
 *
 * Deliberately NOT a brace-counting parse. Braces inside string literals,
 * template literals and comments make that fragile, and fragile here means a
 * wrong FIRING verdict. Instead each declaration owns [its own line, the next
 * declaration's line), which OVER-approximates a test's body — safe in the one
 * direction that matters, since it can never exclude a real in-body assertion.
 * Hooks get their own ranges by the same rule, so a `beforeEach` declared after
 * a test is carved out of that test's range rather than swallowed by it.
 *
 * Lines are 1-based, `endLine` exclusive.
 */
export function testBoundaries(sourceText) {
  const lines = String(sourceText).split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = BOUNDARY_RE.exec(line);
    if (m === null) continue;
    found.push({ kind: m[1], title: titleOn(line), startLine: i + 1 });
  }
  return found.map((d, i) => ({
    kind: d.kind,
    title: d.title,
    startLine: d.startLine,
    endLine: i + 1 < found.length ? found[i + 1].startLine : lines.length + 1,
  }));
}

/**
 * The quoted title on a declaration line, or null.
 *
 * Only the three quote forms this repository's tests actually use. A title
 * containing its own delimiter would be mis-read, which is why the caller
 * treats "no unique match" as unanswerable rather than guessing.
 */
function titleOn(line) {
  const m = /\(\s*(["'`])((?:[^\\]|\\.)*?)\1/.exec(line);
  return m === null ? null : m[2];
}

/**
 * Where the test carrying `title` is declared.
 *
 * Returns `{ ok: true, startLine, endLine }`, or `{ ok: false, reason }` when
 * the title is absent or declared more than once. A duplicated title is REFUSED
 * rather than resolved: the audit computer already decided that question for
 * itself (`audit.ts:672` — "a duplicated title cannot say which one passed"),
 * and the probe confirmed vitest really does report two distinct tests under one
 * identical fullName.
 */
export function rangeOfTest(sourceText, title) {
  const hits = testBoundaries(sourceText).filter(
    (d) => (d.kind === "it" || d.kind === "test") && d.title === title
  );
  if (hits.length === 0) return { ok: false, reason: `no test declares the title ${JSON.stringify(title)}` };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `${hits.length} tests declare the title ${JSON.stringify(title)} — a duplicated title cannot say which one fired`,
    };
  }
  return { ok: true, startLine: hits[0].startLine, endLine: hits[0].endLine };
}

/** The hook ranges, so an assertion landing in one can be named as such. */
export function hookRanges(sourceText) {
  return testBoundaries(sourceText).filter((d) => HOOK_KINDS.has(d.kind));
}

/**
 * Index a `--reporter=json` payload by (file, fullName).
 *
 * `file` is normalised to the repo-relative `tests/<name>` the attestation uses,
 * exactly as `attestationFromVitest` does — the two must key alike or a control
 * pinned by one cannot be found by the other.
 *
 * Duplicates are KEPT as a list rather than collapsed. Collapsing would silently
 * pick a winner, which is the one thing the duplicate case forbids.
 */
export function indexRun(vitestJson) {
  const byKey = new Map();
  const suites =
    typeof vitestJson === "object" && vitestJson !== null && Array.isArray(vitestJson.testResults)
      ? vitestJson.testResults
      : [];
  let total = 0;
  for (const suite of suites) {
    const abs = typeof suite?.name === "string" ? suite.name : "";
    const file = abs.split("\\").join("/").replace(/^.*\/(tests\/[^/]+)$/, "$1");
    for (const t of Array.isArray(suite?.assertionResults) ? suite.assertionResults : []) {
      const fullName = typeof t?.fullName === "string" ? t.fullName : "";
      const key = `${file}\u0000${fullName}`;
      const bucket = byKey.get(key) ?? [];
      bucket.push({
        file,
        fullName,
        title: typeof t?.title === "string" ? t.title : null,
        status: typeof t?.status === "string" ? t.status : "unknown",
        failureMessages: Array.isArray(t?.failureMessages) ? t.failureMessages.map(String) : [],
      });
      byKey.set(key, bucket);
      total++;
    }
  }
  return { byKey, total };
}

/** The single entry for a control, or why there is no single entry. */
export function lookupControl(index, control) {
  const bucket = index.byKey.get(`${control.file}\u0000${control.fullName}`);
  if (bucket === undefined || bucket.length === 0) {
    return { ok: false, reason: `absent from the report: ${control.fullName}` };
  }
  if (bucket.length > 1) {
    return {
      ok: false,
      reason: `${bucket.length} tests in ${control.file} carry the fullName — a duplicated title cannot say which one fired`,
    };
  }
  return { ok: true, entry: bucket[0] };
}

/**
 * The first stack frame pointing into `controlFile`, as a 1-based line.
 *
 * The probe's real frames look like
 *   `    at C:/…/tests/x.test.ts:8:15`
 * and node_modules frames like
 *   `    at file:///C:/…/@vitest/runner/dist/chunk.js:302:11`
 * so matching on the repo-relative suffix is enough to skip runner internals.
 */
function firstFrameLineIn(message, controlFile) {
  const needle = `/${controlFile}:`;
  for (const line of String(message).split("\n")) {
    const at = line.indexOf(needle);
    if (at === -1) continue;
    const m = /:(\d+):\d+/.exec(line.slice(at + controlFile.length));
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/**
 * What a failed control's failure actually WAS.
 *
 * Measured, not assumed. The probe ran an assertion failure and a `beforeEach`
 * failure through this project's vitest and they came back SHAPE-IDENTICAL:
 * same `status: "failed"`, same `failureMessages`, both stacked into the test
 * file, and `location` null on both because `includeTaskLocation` is off here.
 * The only robust discriminator observed is the message prefix.
 *
 * So two gates, and the second is why the line range is parsed at all:
 *  - `AssertionError` prefix — a judgement, not a crash. Covers condition 2 and
 *    a hook that THREW.
 *  - the first control-file frame lands inside the test's own range. Covers the
 *    residual: a hook that fails an `expect` emits `AssertionError` too and is
 *    attributed by vitest to the test.
 */
export function classifyFailure(entry, controlFile, range, hooks) {
  const message = entry.failureMessages[0];
  if (message === undefined) {
    return { outcome: "refused", detail: "the report marks it failed but carries no failure message" };
  }
  if (!/^\s*AssertionError\b/.test(message)) {
    const head = message.split("\n")[0].slice(0, 120);
    return { outcome: "refused", detail: `not an assertion — a crash is not a judgement: ${head}` };
  }
  const line = firstFrameLineIn(message, controlFile);
  if (line === null) {
    return { outcome: "refused", detail: `the assertion's stack names no frame in ${controlFile}` };
  }
  const hook = hooks.find((h) => line >= h.startLine && line < h.endLine);
  if (hook !== undefined) {
    return {
      outcome: "refused",
      detail: `the assertion failed at ${controlFile}:${line}, inside the ${hook.kind} at :${hook.startLine} — vitest attributes a hook failure to the test, but the control's own assertions never ran`,
    };
  }
  if (line < range.startLine || line >= range.endLine) {
    return {
      outcome: "refused",
      detail: `the assertion failed at ${controlFile}:${line}, outside the test's body (${range.startLine}..${range.endLine - 1})`,
    };
  }
  return { outcome: "fired", detail: `assertion failed at ${controlFile}:${line}, inside the control's own body` };
}

/**
 * The whole matrix, one verdict per registered pair.
 *
 * `sources` maps a control file to its text at the BASE commit — the mutant's
 * own text is never used, because a mutation that edited the control file would
 * move the ranges under the verdict.
 *
 * Deterministic by construction: `generatedAt` is an argument, never a clock.
 */
export function evaluateMatrix({ registry, controls, baseline, mutants, sources, baseCommit, generatedAt }) {
  const problems = [];

  // The registry and the clause's own list must cover each other EXACTLY. A
  // control with no mutation is a control this harness silently did not test.
  const registered = new Set(registry.map((r) => `${r.control.file}\u0000${r.control.fullName}`));
  for (const c of controls) {
    if (!registered.has(`${c.file}\u0000${c.fullName}`)) {
      problems.push(`clause 6 lists a control with no registered mutation: ${c.fullName}`);
    }
  }
  const clauseKeys = new Set(controls.map((c) => `${c.file}\u0000${c.fullName}`));
  for (const r of registry) {
    if (!clauseKeys.has(`${r.control.file}\u0000${r.control.fullName}`)) {
      problems.push(`the registry names a control clause 6 does not list: ${r.control.fullName}`);
    }
  }

  const baseIndex = indexRun(baseline);
  const baselineProblems = [];
  for (const c of controls) {
    const found = lookupControl(baseIndex, c);
    if (!found.ok) baselineProblems.push(`baseline: ${found.reason}`);
    else if (found.entry.status !== "passed") {
      baselineProblems.push(`baseline: ${c.fullName} is ${found.entry.status}, not passed — an unmutated control must be green`);
    }
  }

  const pairs = [];
  for (const entry of registry) {
    pairs.push(evaluatePair({ entry, controls, baseIndex, mutants, sources }));
  }

  const allFired = pairs.length > 0 && pairs.every((p) => p.fired);
  return {
    schema: "b12-firing/1",
    baseCommit,
    generatedAt,
    baseline: { allGreen: baselineProblems.length === 0, problems: baselineProblems },
    pairs,
    firedCount: pairs.filter((p) => p.fired).length,
    registeredCount: pairs.length,
    problems,
    allFired: allFired && baselineProblems.length === 0 && problems.length === 0,
  };
}

function evaluatePair({ entry, controls, baseIndex, mutants, sources }) {
  const control = entry.control;
  const out = {
    id: entry.id,
    control,
    subject: entry.subject?.path ?? null,
    fired: false,
    outcome: "refused",
    detail: "",
    offDiagonal: [],
    problems: [],
  };

  const run = mutants[entry.id];
  if (run === undefined || run === null) {
    out.detail = `no mutant run recorded for ${entry.id}`;
    return out;
  }
  if (run.applied !== true) {
    // R35's lesson, mechanised: a regex that matched nothing produced a mutant
    // that never applied, and "the control held" is indistinguishable from
    // "the mutation was never there" unless the runner says so.
    out.detail = `the mutation was not applied (${String(run.notApplied ?? "runner reported applied=false")})`;
    return out;
  }

  const source = sources[control.file];
  if (typeof source !== "string") {
    out.detail = `no base text supplied for ${control.file} — the body range cannot be parsed`;
    return out;
  }

  const base = lookupControl(baseIndex, control);
  if (!base.ok) {
    out.detail = `baseline: ${base.reason}`;
    return out;
  }
  const title = base.entry.title;
  if (typeof title !== "string" || title === "") {
    out.detail = "the baseline report carries no title for the control — its declaration cannot be located";
    return out;
  }
  const range = rangeOfTest(source, title);
  if (!range.ok) {
    out.detail = range.reason;
    return out;
  }

  const mutantIndex = indexRun(run.report);
  const found = lookupControl(mutantIndex, control);
  if (!found.ok) {
    out.detail = `mutant run: ${found.reason}`;
    return out;
  }
  if (found.entry.status !== "failed") {
    out.detail = `the control is ${found.entry.status} under its own mutation — it did not fire`;
  } else {
    const verdict = classifyFailure(found.entry, control.file, range, hookRanges(source));
    out.outcome = verdict.outcome;
    out.detail = verdict.detail;
  }

  // The off-diagonal. Sensitivity without specificity is one control wearing
  // six titles: deleting the subject file reddens them all.
  const declared = new Map((entry.collateral ?? []).map((c) => [c.fullName, c.reason]));
  for (const other of controls) {
    if (other.file === control.file && other.fullName === control.fullName) continue;
    const o = lookupControl(mutantIndex, other);
    const status = o.ok ? o.entry.status : "unanswerable";
    const isGreen = status === "passed";
    const reason = declared.get(other.fullName);
    const ok = isGreen || reason !== undefined;
    out.offDiagonal.push({
      fullName: other.fullName,
      status,
      declared: reason ?? null,
      ok,
      ...(o.ok ? {} : { note: o.reason }),
    });
    if (!ok) {
      out.problems.push(`undeclared collateral: ${other.fullName} is ${status} under ${entry.id}`);
    }
  }

  out.fired = out.outcome === "fired" && out.problems.length === 0;
  return out;
}
