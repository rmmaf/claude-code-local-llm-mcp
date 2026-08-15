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
 * `docs/b12-scorer/MUTATION-HARNESS-PLAN.md` §2.
 *
 * R39 rewrote three things here, each of which had been written the cheap way:
 * the declaration scanner is now a real TypeScript parse, stack frames are
 * resolved against the repository root instead of suffix-matched, and the
 * matrix refuses duplicate identities instead of letting them collapse.
 */
import ts from "typescript";

/** The call names that own a range. */
const TEST_KINDS = new Set(["it", "test"]);
const HOOK_KINDS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const ALL_KINDS = new Set([...TEST_KINDS, ...HOOK_KINDS, "describe", "suite"]);

/** `it`, `it.only`, `it.each(...)`, `describe.skip` — the leftmost identifier. */
function calleeName(expr) {
  let node = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isElementAccessExpression(node)) node = node.expression;
    else break;
  }
  return ts.isIdentifier(node) ? node.text : null;
}

/** The title argument, when it is a plain string the reporter would echo back. */
function titleOf(arg) {
  if (arg === undefined) return null;
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null; // a computed title is not one this can match by name
}

function firstCallback(node) {
  for (const arg of node.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
  }
  return null;
}

/**
 * Every `it`/`test`/`describe`/hook declaration, with the EXACT line range of
 * its callback body.
 *
 * R39#2 replaced a line scanner here. The scanner owned [its line, the next
 * declaration's line) and its header claimed that could never exclude a real
 * in-body assertion. False, and in three ways: a commented-out `// it(` was
 * matched as a boundary ON PURPOSE and truncated the enclosing test, a template
 * literal opening with `it(` did the same, and a declaration whose title sat on
 * the following line recorded no title at all. A parse has none of those
 * failure modes because a comment is not a CallExpression.
 *
 * Lines are 1-based; `bodyStart`..`bodyEnd` are INCLUSIVE and cover the
 * callback body only, so a hook nested in the same `describe` is naturally
 * disjoint from every test's range rather than carved out by hand.
 */
export function testBoundaries(sourceText, fileName = "control.test.ts") {
  const sf = ts.createSourceFile(fileName, String(sourceText), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = calleeName(node.expression);
      if (kind !== null && ALL_KINDS.has(kind)) {
        const cb = firstCallback(node);
        const body = cb === null ? null : cb.body;
        out.push({
          kind,
          title: titleOf(node.arguments[0]),
          startLine: lineOf(node.getStart(sf)),
          bodyStart: body === null ? lineOf(node.getStart(sf)) : lineOf(body.getStart(sf)),
          bodyEnd: body === null ? lineOf(node.end) : lineOf(body.end),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Where the test carrying `title` has its body.
 *
 * A duplicated title is REFUSED rather than resolved: the audit computer already
 * decided that question for itself (`audit.ts:672` — "a duplicated title cannot
 * say which one passed"), and the probe confirmed vitest really does report two
 * distinct tests under one identical fullName.
 */
export function rangeOfTest(sourceText, title, fileName) {
  const hits = testBoundaries(sourceText, fileName).filter((d) => TEST_KINDS.has(d.kind) && d.title === title);
  if (hits.length === 0) return { ok: false, reason: `no test declares the title ${JSON.stringify(title)}` };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `${hits.length} tests declare the title ${JSON.stringify(title)} — a duplicated title cannot say which one fired`,
    };
  }
  return { ok: true, startLine: hits[0].bodyStart, endLine: hits[0].bodyEnd };
}

/** Hook body ranges, so an assertion landing in one can be NAMED as such. */
export function hookRanges(sourceText, fileName) {
  return testBoundaries(sourceText, fileName).filter((d) => HOOK_KINDS.has(d.kind));
}

/**
 * A stack path or reporter suite name reduced to its repo-relative form.
 *
 * R39#3. The previous rule searched for the substring `/<controlFile>:`, which
 * both MISSED real frames (Windows backslashes, `file://` URLs) and MATCHED
 * wrong ones: `…/tests/fixtures/x/tests/cost-meter.test.ts` carries
 * `/tests/cost-meter.test.ts` as a suffix, and this repository really does have
 * a `tests/fixtures/` tree. Exact equality against a resolved relative path is
 * the only form that is safe in both directions.
 *
 * Returns null when the path is outside the root — a frame in `node_modules`
 * resolves, but a frame on another drive does not, and neither is the control.
 */
export function relativeTo(root, raw) {
  let p = String(raw).trim();
  if (p.startsWith("file:///")) p = decodeURIComponent(p.slice(8));
  else if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
  p = p.split("\\").join("/");
  const r = String(root ?? "").split("\\").join("/").replace(/\/+$/, "");
  if (r === "") return p;
  // Windows paths are case-insensitive; the comparison is, the RESULT is not.
  if (p.toLowerCase() === r.toLowerCase()) return "";
  if (!p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return null;
  return p.slice(r.length + 1);
}

/**
 * Index a `--reporter=json` payload by (file, fullName).
 *
 * With `repoRoot` the suite path is relativised EXACTLY. Without it the legacy
 * `tests/<name>` regex is used — byte-identical to `attestationFromVitest`'s, so
 * the two key alike, which they must or a control the audit pins cannot be found
 * here. That shared expression cannot express `tests/<dir>/<name>`; both
 * conformance files are direct children of `tests/` and pinned under the
 * 2026-08-10 amendment, so the nested case cannot arise for the six — recorded
 * as a limitation rather than fixed here, because changing it moves the
 * attestation's keys too.
 *
 * Duplicates are KEPT as a list rather than collapsed. Collapsing would silently
 * pick a winner, which is the one thing the duplicate case forbids.
 */
export function indexRun(vitestJson, repoRoot) {
  const byKey = new Map();
  const suites =
    typeof vitestJson === "object" && vitestJson !== null && Array.isArray(vitestJson.testResults)
      ? vitestJson.testResults
      : [];
  let total = 0;
  for (const suite of suites) {
    const abs = typeof suite?.name === "string" ? suite.name : "";
    const file =
      repoRoot === undefined || repoRoot === null
        ? abs.split("\\").join("/").replace(/^.*\/(tests\/[^/]+)$/, "$1")
        : (relativeTo(repoRoot, abs) ?? abs.split("\\").join("/"));
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

/** One `at …:line:col` stack frame, path and line, or null. */
export function parseFrame(line) {
  const m = /^\s*at\s+(?:.*?\s+)?\(?(.+?):(\d+):(\d+)\)?\s*$/.exec(String(line));
  return m === null ? null : { path: m[1], line: Number(m[2]) };
}

/** Every line, in the control file, that this failure's stack passes through. */
function framesInControl(message, controlFile, repoRoot) {
  const lines = [];
  for (const raw of String(message).split("\n")) {
    const frame = parseFrame(raw);
    if (frame === null) continue;
    if (relativeTo(repoRoot, frame.path) !== controlFile) continue;
    lines.push(frame.line);
  }
  return lines;
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
 * Two gates, and the second is why the body range is parsed at all:
 *  - `AssertionError` prefix — a judgement, not a crash. Covers a hook that
 *    THREW, and a timeout, and a module-load error.
 *  - SOME frame in the control file lands inside the test's own body. Covers the
 *    residual: a hook that fails an `expect` emits `AssertionError` too and is
 *    attributed by vitest to the test. ANY frame rather than the first, so an
 *    assertion raised inside a helper the test calls still credits the test —
 *    the call chain reaches back into the body, while a hook's never does.
 *
 * KNOWN LIMIT: the prefix is not a universal definition of judgement. A control
 * failing via an unhandled rejection or a bare timeout is refused rather than
 * counted, which understates. All six current controls use ordinary `expect`
 * matchers, verified.
 */
export function classifyFailure(entry, controlFile, range, hooks, repoRoot) {
  const message = entry.failureMessages[0];
  if (message === undefined) {
    return { outcome: "refused", detail: "the report marks it failed but carries no failure message" };
  }
  if (!/^\s*AssertionError\b/.test(message)) {
    const head = message.split("\n")[0].slice(0, 120);
    return { outcome: "refused", detail: `not an assertion — a crash is not a judgement: ${head}` };
  }
  const lines = framesInControl(message, controlFile, repoRoot);
  if (lines.length === 0) {
    return { outcome: "refused", detail: `the assertion's stack names no frame in ${controlFile}` };
  }
  const inBody = lines.find((l) => l >= range.startLine && l <= range.endLine);
  if (inBody !== undefined) {
    return { outcome: "fired", detail: `assertion failed at ${controlFile}:${inBody}, inside the control's own body` };
  }
  const hook = hooks.find((h) => lines.some((l) => l >= h.bodyStart && l <= h.bodyEnd));
  if (hook !== undefined) {
    return {
      outcome: "refused",
      detail: `the assertion failed inside the ${hook.kind} at ${controlFile}:${hook.startLine} — vitest attributes a hook failure to the test, but the control's own assertions never ran`,
    };
  }
  return {
    outcome: "refused",
    detail: `the assertion failed at ${controlFile}:${lines[0]}, outside the test's body (${range.startLine}..${range.endLine})`,
  };
}

/**
 * The whole matrix, one verdict per registered pair.
 *
 * `sources` maps a control file to its text at the BASE commit — the mutant's
 * own text is never used, because a mutation that edited the control file would
 * move the ranges under the verdict.
 *
 * Deterministic by construction: `generatedAt` is an argument, never a clock.
 *
 * `allFired` DECIDES NOTHING ON ITS OWN. R39#1: this function trusts the
 * `controls` it is handed, so a caller passing one control gets `allFired: true`
 * over one pair. The artifact therefore publishes `controlsEvaluated`, and the
 * audit-side reader compares that set against `CONTROL_TESTS` — the check lives
 * where the clause's own list lives, not here. What IS enforced here is that
 * nothing collapses: duplicate mutation ids and duplicate control keys are
 * refused, because either lets two pairs consume one report.
 */
export function evaluateMatrix({ registry, controls, baseline, mutants, sources, baseCommit, generatedAt, repoRoot }) {
  const problems = [];

  const seenIds = new Set();
  for (const r of registry) {
    if (seenIds.has(r.id)) problems.push(`duplicate mutation id ${JSON.stringify(r.id)} — two pairs cannot share one report`);
    seenIds.add(r.id);
  }
  const keyOf = (c) => `${c.file}\u0000${c.fullName}`;
  const seenControls = new Set();
  for (const r of registry) {
    if (seenControls.has(keyOf(r.control))) {
      problems.push(`duplicate registered control: ${r.control.fullName}`);
    }
    seenControls.add(keyOf(r.control));
  }
  const seenClause = new Set();
  for (const c of controls) {
    if (seenClause.has(keyOf(c))) problems.push(`the control list repeats ${c.fullName}`);
    seenClause.add(keyOf(c));
  }

  // The registry and the clause's own list must cover each other EXACTLY. A
  // control with no mutation is a control this harness silently did not test.
  for (const c of controls) {
    if (!seenControls.has(keyOf(c))) {
      problems.push(`clause 6 lists a control with no registered mutation: ${c.fullName}`);
    }
  }
  for (const r of registry) {
    if (!seenClause.has(keyOf(r.control))) {
      problems.push(`the registry names a control clause 6 does not list: ${r.control.fullName}`);
    }
  }

  const baseIndex = indexRun(baseline, repoRoot);
  const baselineProblems = [];
  for (const c of controls) {
    const found = lookupControl(baseIndex, c);
    if (!found.ok) baselineProblems.push(`baseline: ${found.reason}`);
    else if (found.entry.status !== "passed") {
      baselineProblems.push(`baseline: ${c.fullName} is ${found.entry.status}, not passed — an unmutated control must be green`);
    }
  }

  const pairs = registry.map((entry) => evaluatePair({ entry, controls, baseIndex, mutants, sources, repoRoot }));
  const allFired = pairs.length > 0 && pairs.every((p) => p.fired);
  return {
    schema: "b12-firing/1",
    baseCommit,
    generatedAt,
    /** What the audit-side reader compares against CONTROL_TESTS. */
    controlsEvaluated: controls.map((c) => ({ file: c.file, fullName: c.fullName })),
    baseline: { allGreen: baselineProblems.length === 0, problems: baselineProblems },
    pairs,
    firedCount: pairs.filter((p) => p.fired).length,
    registeredCount: pairs.length,
    problems,
    /**
     * SENSITIVITY — each control goes red when its own subject breaks, with the
     * assertion inside its own body. This is clause 6's frozen word FIRING, and
     * it is the only thing `allFired` has ever been entitled to mean.
     */
    allFired: allFired && baselineProblems.length === 0 && problems.length === 0,
    /**
     * SPECIFICITY — REPORTED, DECIDING NOTHING. Whether anything outside the
     * diagonal went red. Requiring it would mint a condition the frozen text
     * does not carry; hiding it would let a mutation that reddens the file read
     * as a clean kill, which is what R43#2 caught. So it is published, whole.
     */
    specificityClean: pairs.every((p) => p.specificityClean),
    offDiagonalKillCount: pairs.reduce((n, p) => n + p.offDiagonalFailures.length, 0),
  };
}

function evaluatePair({ entry, controls, baseIndex, mutants, sources, repoRoot }) {
  const control = entry.control;
  const out = {
    id: entry.id,
    control,
    subject: entry.subject?.path ?? null,
    fired: false,
    outcome: "refused",
    detail: "",
    offDiagonal: [],
    /** The RAW kill set outside the diagonal. Waives nothing; annotates only. */
    offDiagonalFailures: [],
    specificityClean: false,
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
  const range = rangeOfTest(source, title, control.file);
  if (!range.ok) {
    out.detail = range.reason;
    return out;
  }

  const mutantIndex = indexRun(run.report, repoRoot);
  const found = lookupControl(mutantIndex, control);
  if (!found.ok) {
    out.detail = `mutant run: ${found.reason}`;
    return out;
  }
  if (found.entry.status !== "failed") {
    out.detail = `the control is ${found.entry.status} under its own mutation — it did not fire`;
  } else {
    const verdict = classifyFailure(found.entry, control.file, range, hookRanges(source, control.file), repoRoot);
    out.outcome = verdict.outcome;
    out.detail = verdict.detail;
  }

  // The off-diagonal. Sensitivity without specificity is one control wearing
  // six titles: deleting the subject file reddens them all.
  const declared = new Map((entry.collateral ?? []).map((c) => [c.fullName, c.reason]));

  // R40#1/#2: over the WHOLE conformance file, not merely the six. Restricting
  // specificity to the registered controls made two things invisible at once —
  // a mutation reddening unrelated tests in the same file, and a worker crash or
  // late unhandled rejection that reddens something else while the diagonal
  // fails for its own reasons. Either turns a broad mutation into a clean-looking
  // firing. Every failure in the run must be the diagonal or declared.
  // R43#2 CHANGED WHAT THIS DOES. It used to push undeclared failures into
  // `problems`, which gated `fired` — so a DECLARATION made a red test
  // acceptable and "clean off-diagonal" meant only "every red test was
  // whitelisted". Reasons are unchecked prose; a declaration cannot establish
  // causality; and run 2 passed because run 1's failures had been listed.
  //
  // Now the raw kill set is recorded WHOLE and waives nothing. Annotations
  // explain; they never convert a failure to OK. And specificity is reported
  // beside sensitivity rather than folded into it, because clause 6's frozen
  // word is FIRING — that is sensitivity — and requiring specificity would mint
  // a condition the frozen text does not carry.
  for (const [, bucket] of mutantIndex.byKey) {
    for (const other of bucket) {
      if (other.status !== "failed") continue;
      if (other.fullName === control.fullName && other.file === control.file) continue;
      out.offDiagonalFailures.push({
        file: other.file,
        fullName: other.fullName,
        annotation: declared.get(other.fullName) ?? null,
      });
    }
  }
  out.specificityClean = out.offDiagonalFailures.length === 0;
  for (const c of entry.collateral ?? []) {
    if (!out.offDiagonalFailures.some((f) => f.fullName === c.fullName)) {
      out.problems.push(`the registry annotates ${c.fullName} under ${entry.id}, which did not fail — a stale annotation describes nothing`);
    }
  }

  for (const other of controls) {
    if (other.file === control.file && other.fullName === control.fullName) continue;
    const o = lookupControl(mutantIndex, other);
    const status = o.ok ? o.entry.status : "unanswerable";
    const reason = declared.get(other.fullName);
    // ONLY A PASS IS OK. This read `status === "passed" || reason !== undefined`,
    // which is the last place a DECLARATION still converted something into OK —
    // the exact conversion R43#2 removed from the whole-file sweep above and
    // did not remove here.
    //
    // AND IT WAS WORSE HERE THAN IT WOULD HAVE BEEN THERE. Up there a
    // declaration excused a FAILURE, which is at least the thing an annotation
    // is about. Down here the status it silenced is `unanswerable` — the mutant
    // report has no entry for that control at all. An annotation says "this
    // test goes red as collateral"; it cannot say why the report does not
    // mention the test, because those are not the same claim and the second one
    // is an ABSENCE OF EVIDENCE. A registry entry was buying silence about a
    // question the run never answered.
    //
    // The annotation is still published on the row as `declared`. It explains;
    // it does not decide — which is the whole of R43#2 stated once more.
    const ok = status === "passed";
    out.offDiagonal.push({
      fullName: other.fullName,
      status,
      declared: reason ?? null,
      ok,
      ...(o.ok ? {} : { note: o.reason }),
    });
    // A failed sibling is already named by the whole-file sweep above; what only
    // THIS loop can see is a registered control the report cannot answer for.
    if (!ok && status !== "failed") {
      out.problems.push(`the mutant run cannot answer for ${other.fullName} (${status}) under ${entry.id}`);
    }
  }

  out.fired = out.outcome === "fired" && out.problems.length === 0;
  return out;
}
