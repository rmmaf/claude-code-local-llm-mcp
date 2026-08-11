/**
 * The mutation harness's SELF-TEST — R38#5.
 *
 * Revision 1 of the plan registered a vacuous seventh control living outside the
 * conformance suite and called being outside a virtue. It is the defect: outside
 * the suite it travels a different lookup path, so it cannot catch an acceptance
 * rule inverted for registered controls only. It would have certified six broken
 * controls while looking green.
 *
 * So the evaluator is exercised directly, on payloads pushed through the SAME
 * parsing, identity and acceptance functions the six controls travel. The
 * assertion-failure and hook-failure payloads are NOT invented: they are the
 * shapes a throwaway probe captured from this project's own vitest, which is why
 * `location` is absent everywhere below and why the hook case carries a plain
 * `Error:` prefix rather than the `AssertionError:` a plan assumed.
 *
 * This file is not in `CONFORMANCE_FILES` and must never be: it tests the
 * measurer, not the meter.
 */
import { describe, it, expect } from "vitest";
import {
  testBoundaries,
  rangeOfTest,
  indexRun,
  lookupControl,
  classifyFailure,
  hookRanges,
  evaluateMatrix,
  relativeTo,
  parseFrame,
} from "../scripts/b12-firing.mjs";
import type { RegistryEntry } from "../scripts/b12-firing.mjs";

const REPO = "C:/repo";
const FILE = "tests/fake.test.ts";
const ALPHA = { file: FILE, fullName: "suite alpha" };
const BETA = { file: FILE, fullName: "suite beta" };
const CONTROLS = [ALPHA, BETA];

/**
 * The fixture source, with the line numbers the assertions below depend on:
 *  1 describe · 2 beforeEach (owns 2..4) · 5 it alpha (owns 5..7)
 *  8 it beta (owns 8..11)
 */
const SOURCE = [
  /* 1 */ 'describe("suite", () => {',
  /* 2 */ "  beforeEach(() => {",
  /* 3 */ "    setup();",
  /* 4 */ "  });",
  /* 5 */ '  it("alpha", () => {',
  /* 6 */ "    expect(a).toBe(1);",
  /* 7 */ "  });",
  /* 8 */ '  it("beta", () => {',
  /* 9 */ "    expect(b).toBe(2);",
  /* 10 */ "  });",
  /* 11 */ "});",
].join("\n");

const SOURCES = { [FILE]: SOURCE };

/** The probe's real assertion payload, retargeted at the fixture's path. */
const assertionAt = (line: number): string =>
  [
    "AssertionError: expected 1 to be 2 // Object.is equality",
    `    at C:/repo/${FILE}:${line}:15`,
    "    at file:///C:/repo/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11",
    "    at file:///C:/repo/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26",
  ].join("\n");

/** The probe's real HOOK payload — note the prefix is `Error:`, not `AssertionError:`. */
const hookThrewAt = (line: number): string =>
  [
    "Error: hook exploded",
    `    at C:/repo/${FILE}:${line}:11`,
    "    at file:///C:/repo/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11",
    "    at wrapper (file:///C:/repo/node_modules/@vitest/runner/dist/chunk-artifact.js:722:10)",
  ].join("\n");

type Assertion = { fullName: string; title: string; status: string; failureMessages: string[] };

const t = (fullName: string, title: string, status: string, failureMessages: string[] = []): Assertion => ({
  fullName,
  title,
  status,
  failureMessages,
});

const report = (tests: Assertion[]): unknown => ({
  testResults: [{ name: `C:\\repo\\${FILE.split("/").join("\\")}`, assertionResults: tests }],
});

const GREEN = report([t("suite alpha", "alpha", "passed"), t("suite beta", "beta", "passed")]);

const M_ALPHA: RegistryEntry = {
  id: "m-alpha",
  control: ALPHA,
  subject: { path: "src/a.ts", find: "x", replace: "y", occurrences: 1 },
};
const M_BETA: RegistryEntry = {
  id: "m-beta",
  control: BETA,
  subject: { path: "src/b.ts", find: "x", replace: "y", occurrences: 1 },
};
const REGISTRY: RegistryEntry[] = [M_ALPHA, M_BETA];

const evaluate = (
  mutants: Record<string, { applied: boolean; notApplied?: string; report: unknown } | null>,
  registry: RegistryEntry[] = REGISTRY,
  baseline: unknown = GREEN
): ReturnType<typeof evaluateMatrix> =>
  evaluateMatrix({
    registry,
    controls: CONTROLS,
    baseline,
    mutants,
    sources: SOURCES,
    baseCommit: "0".repeat(40),
    generatedAt: "2026-08-11T00:00:00Z",
    repoRoot: REPO,
  });

/** The whole matrix green: each mutation kills its own control and only its own. */
const BOTH_FIRE = {
  "m-alpha": {
    applied: true,
    report: report([t("suite alpha", "alpha", "failed", [assertionAt(6)]), t("suite beta", "beta", "passed")]),
  },
  "m-beta": {
    applied: true,
    report: report([t("suite alpha", "alpha", "passed"), t("suite beta", "beta", "failed", [assertionAt(9)])]),
  },
};

const pairOf = (out: ReturnType<typeof evaluateMatrix>, id: string) => out.pairs.find((p) => p.id === id);

describe("the mutation harness evaluator", () => {
  it("parses declaration bodies from the AST, exactly", () => {
    const b = testBoundaries(SOURCE, FILE);
    expect(b.map((x) => `${x.kind}:${x.title ?? "-"}@${x.bodyStart}..${x.bodyEnd}`)).toEqual([
      "describe:suite@1..11",
      "beforeEach:-@2..4",
      "it:alpha@5..7",
      "it:beta@8..10",
    ]);
    expect(hookRanges(SOURCE, FILE).map((h) => h.kind)).toEqual(["beforeEach"]);
  });

  // ---- R39#2: the three layouts that broke the line scanner this replaced

  it("does not treat a COMMENTED-OUT declaration as a boundary", () => {
    // The scanner matched `// it(` on purpose, so a commented declaration inside
    // a body truncated the real test and excluded every assertion after it.
    const src = [
      'describe("s", () => {',
      '  it("solo", () => {',
      "    // it(\"dead\", () => {});",
      "    expect(a).toBe(1);",
      "  });",
      "});",
    ].join("\n");
    const r = rangeOfTest(src, "solo", FILE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.endLine).toBe(5); // NOT truncated at the comment on line 3
  });

  it("does not treat a template literal opening with it( as a boundary", () => {
    const src = [
      'describe("s", () => {',
      '  it("solo", () => {',
      "    const snippet = `",
      'it("not a test", () => {});',
      "`;",
      "    expect(snippet).toBeTruthy();",
      "  });",
      "});",
    ].join("\n");
    const r = rangeOfTest(src, "solo", FILE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.endLine).toBe(7);
  });

  it("finds a title declared on the line AFTER the call opens", () => {
    const src = ['describe("s", () => {', "  it(", '    "wrapped",', "    () => {", "      expect(a).toBe(1);", "    }", "  );", "});"].join("\n");
    const r = rangeOfTest(src, "wrapped", FILE);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.startLine, r.endLine]).toEqual([4, 6]);
  });

  // ---- R39#3: paths resolve, they are not suffix-matched

  it("REFUSES a frame from a nested tests/ directory that merely ENDS the same way", () => {
    // This repository really carries tests/fixtures/**, so the collision is live.
    expect(relativeTo(REPO, `${REPO}/tests/fixtures/x/tests/fake.test.ts`)).toBe("tests/fixtures/x/tests/fake.test.ts");
    const collide = report([
      t("suite alpha", "alpha", "failed", [
        ["AssertionError: expected 1 to be 2", `    at ${REPO}/tests/fixtures/x/tests/fake.test.ts:6:15`].join("\n"),
      ]),
      t("suite beta", "beta", "passed"),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: collide } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("names no frame in");
  });

  it("resolves Windows backslash frames and file:// URLs", () => {
    expect(relativeTo(REPO, "C:\\repo\\tests\\fake.test.ts")).toBe(FILE);
    expect(relativeTo(REPO, `file:///${REPO}/tests/fake.test.ts`)).toBe(FILE);
    expect(relativeTo(REPO, "D:/elsewhere/tests/fake.test.ts")).toBeNull();
    expect(parseFrame(`    at ${REPO}/tests/fake.test.ts:6:15`)).toEqual({ path: `${REPO}/tests/fake.test.ts`, line: 6 });
    expect(parseFrame(`    at wrapper (file:///${REPO}/x.js:722:10)`)).toEqual({ path: `file:///${REPO}/x.js`, line: 722 });
  });

  it("credits an assertion raised inside a helper the test called", () => {
    // ANY frame in the body, not the first: the chain reaches back into the
    // test. A hook's chain never does, which is what keeps the two apart.
    const viaHelper = report([
      t("suite alpha", "alpha", "failed", [
        [
          "AssertionError: expected 1 to be 2",
          `    at helper (${REPO}/${FILE}:2:5)`,
          `    at ${REPO}/${FILE}:6:15`,
        ].join("\n"),
      ]),
      t("suite beta", "beta", "passed"),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: viaHelper } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(true);
  });

  // ---- R39#1: nothing may collapse, and allFired does not stand alone

  it("REFUSES duplicate mutation ids — two pairs cannot consume one report", () => {
    const out = evaluate(BOTH_FIRE, [M_ALPHA, { ...M_BETA, id: "m-alpha" }]);
    expect(out.problems.join(" ")).toContain("duplicate mutation id");
    expect(out.allFired).toBe(false);
  });

  it("REFUSES the same control registered twice", () => {
    const out = evaluate(BOTH_FIRE, [M_ALPHA, { ...M_BETA, control: ALPHA }]);
    expect(out.problems.join(" ")).toContain("duplicate registered control");
  });

  it("publishes the control set it evaluated, so the audit can check it against CONTROL_TESTS", () => {
    // allFired quantifies over the controls it was HANDED. A one-control matrix
    // is still allFired: true, which is exactly why the set is on the artifact's
    // face and the six-ness is decided where CONTROL_TESTS lives.
    const out = evaluateMatrix({
      registry: [M_ALPHA],
      controls: [ALPHA],
      baseline: report([t("suite alpha", "alpha", "passed")]),
      mutants: { "m-alpha": BOTH_FIRE["m-alpha"] },
      sources: SOURCES,
      baseCommit: "0".repeat(40),
      generatedAt: "2026-08-11T00:00:00Z",
      repoRoot: REPO,
    });
    expect(out.allFired).toBe(true);
    expect(out.controlsEvaluated).toEqual([{ file: FILE, fullName: "suite alpha" }]);
  });

  it("accepts the whole matrix when each mutation kills its own control and only its own", () => {
    const out = evaluate(BOTH_FIRE);
    expect(out.baseline.allGreen).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.firedCount).toBe(2);
    expect(out.allFired).toBe(true);
    expect(pairOf(out, "m-alpha")?.detail).toContain("inside the control's own body");
  });

  // ---- the inverted-verdict family: what R38#5 said the vacuous control missed

  it("REFUSES a control that passes under its own mutation", () => {
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: GREEN } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("did not fire");
    expect(out.allFired).toBe(false);
  });

  it("REFUSES an all-fail report — six red controls are not six firings", () => {
    const allRed = report([
      t("suite alpha", "alpha", "failed", [assertionAt(6)]),
      t("suite beta", "beta", "failed", [assertionAt(9)]),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: allRed } });
    const pair = pairOf(out, "m-alpha");
    expect(pair?.outcome).toBe("fired"); // the diagonal alone WOULD have accepted it
    expect(pair?.fired).toBe(false); // but specificity does not
    expect(pair?.problems.join(" ")).toContain("undeclared collateral");
  });

  it("REFUSES collateral OUTSIDE the six — a broad mutation is not a clean firing", () => {
    // R40#1/#2: specificity used to be checked only across the registered
    // controls, so a mutation reddening unrelated tests in the same file, or a
    // worker crash reddening something else, read as a clean kill.
    const spills = report([
      t("suite alpha", "alpha", "failed", [assertionAt(6)]),
      t("suite beta", "beta", "passed"),
      t("other suite unrelated", "unrelated", "failed", [assertionAt(9)]),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: spills } });
    expect(pairOf(out, "m-alpha")?.outcome).toBe("fired");
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.problems.join(" ")).toContain("other suite unrelated");
  });

  it("accepts collateral that was DECLARED, with its reason, and only that", () => {
    const allRed = report([
      t("suite alpha", "alpha", "failed", [assertionAt(6)]),
      t("suite beta", "beta", "failed", [assertionAt(9)]),
    ]);
    const declared: RegistryEntry[] = [
      { ...M_ALPHA, collateral: [{ fullName: "suite beta", reason: "shares the clamp under test" }] },
      M_BETA,
    ];
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: allRed } }, declared);
    const pair = pairOf(out, "m-alpha");
    expect(pair?.fired).toBe(true);
    expect(pair?.offDiagonal.find((o) => o.fullName === "suite beta")?.declared).toBe("shares the clamp under test");
  });

  // ---- the two the probe measured, and the residual between them

  it("REFUSES a crash — a throwing hook is not a judgement", () => {
    const crashed = report([t("suite alpha", "alpha", "failed", [hookThrewAt(3)]), t("suite beta", "beta", "passed")]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: crashed } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("not an assertion");
  });

  it("REFUSES an AssertionError raised inside a hook, which vitest attributes to the test", () => {
    // The residual hole the prefix rule alone cannot close, and the whole reason
    // the body range is parsed rather than skipped as fiddly.
    const inHook = report([t("suite alpha", "alpha", "failed", [assertionAt(3)]), t("suite beta", "beta", "passed")]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: inHook } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("beforeEach");
  });

  it("REFUSES an assertion that failed in another test's body", () => {
    const elsewhere = report([
      t("suite alpha", "alpha", "failed", [assertionAt(9)]),
      t("suite beta", "beta", "passed"),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: elsewhere } });
    expect(pairOf(out, "m-alpha")?.detail).toContain("outside the test's body");
  });

  // ---- identity: the ways a report can fail to say WHICH test it means

  it("REFUSES a duplicated fullName rather than picking a winner", () => {
    const dup = report([
      t("suite alpha", "alpha", "failed", [assertionAt(6)]),
      t("suite alpha", "alpha", "passed"),
      t("suite beta", "beta", "passed"),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: dup } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("duplicated title");
    expect(lookupControl(indexRun(dup), ALPHA).ok).toBe(false);
  });

  it("REFUSES a duplicated title in the SOURCE too — the range would be a guess", () => {
    const twice = `${SOURCE}\n${'  it("alpha", () => {'}\n    expect(c).toBe(3);\n  });`;
    const r = rangeOfTest(twice, "alpha");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cannot say which one fired");
  });

  it("REFUSES a control missing from the report", () => {
    const missing = report([t("suite beta", "beta", "passed")]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: missing } });
    expect(pairOf(out, "m-alpha")?.detail).toContain("absent from the report");
  });

  it("REFUSES swapped names — a result filed under the wrong control is not that control's", () => {
    // alpha's failure arrives labelled beta. Keying by (file, fullName) means
    // alpha reads as passing, which must not be a firing.
    const swapped = report([
      t("suite beta", "beta", "failed", [assertionAt(6)]),
      t("suite alpha", "alpha", "passed"),
    ]);
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: swapped } });
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(pairOf(out, "m-alpha")?.detail).toContain("did not fire");
  });

  it("REFUSES a report with no tests at all", () => {
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": { applied: true, report: { testResults: [] } } });
    expect(indexRun({ testResults: [] }).total).toBe(0);
    expect(pairOf(out, "m-alpha")?.fired).toBe(false);
    expect(out.allFired).toBe(false);
  });

  // ---- the runner's honesty fields, and the registry's own coverage

  it("REFUSES a pair whose mutation never applied — R35, mechanised", () => {
    const out = evaluate({
      ...BOTH_FIRE,
      "m-alpha": { applied: false, notApplied: "0 occurrences, wanted 1", report: GREEN },
    });
    expect(pairOf(out, "m-alpha")?.detail).toContain("0 occurrences");
    expect(out.allFired).toBe(false);
  });

  it("REFUSES a pair with no mutant run recorded", () => {
    const out = evaluate({ ...BOTH_FIRE, "m-alpha": null });
    expect(pairOf(out, "m-alpha")?.detail).toContain("no mutant run recorded");
  });

  it("names a clause-6 control the registry never mutates", () => {
    const out = evaluate(BOTH_FIRE, [M_ALPHA]);
    expect(out.problems.join(" ")).toContain("no registered mutation");
    expect(out.allFired).toBe(false);
  });

  it("names a registered control clause 6 does not list", () => {
    const stranger: RegistryEntry = { id: "m-x", control: { file: FILE, fullName: "suite gamma" } };
    const out = evaluate(BOTH_FIRE, [...REGISTRY, stranger]);
    expect(out.problems.join(" ")).toContain("does not list");
  });

  it("REFUSES the whole matrix when a control is already red at baseline", () => {
    const redBase = report([
      t("suite alpha", "alpha", "failed", [assertionAt(6)]),
      t("suite beta", "beta", "passed"),
    ]);
    const out = evaluate(BOTH_FIRE, REGISTRY, redBase);
    expect(out.baseline.allGreen).toBe(false);
    expect(out.baseline.problems.join(" ")).toContain("must be green");
    expect(out.allFired).toBe(false);
  });

  it("is deterministic: the same inputs produce byte-identical artifacts", () => {
    expect(JSON.stringify(evaluate(BOTH_FIRE))).toBe(JSON.stringify(evaluate(BOTH_FIRE)));
  });

  it("classifyFailure is reachable directly, so the acceptance rule is not only testable through the matrix", () => {
    const range = rangeOfTest(SOURCE, "alpha");
    expect(range.ok).toBe(true);
    if (!range.ok) return;
    const hooks = hookRanges(SOURCE);
    const entry = { file: FILE, fullName: "suite alpha", title: "alpha", status: "failed", failureMessages: [assertionAt(6)] };
    expect(classifyFailure(entry, FILE, range, hooks, REPO).outcome).toBe("fired");
    expect(classifyFailure({ ...entry, failureMessages: [] }, FILE, range, hooks, REPO).outcome).toBe("refused");
  });
});
