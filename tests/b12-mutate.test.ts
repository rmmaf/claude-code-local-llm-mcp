/**
 * The mutation REGISTRY's own guard.
 *
 * The runner's execution is not unit tested — it creates worktrees, installs and
 * builds, and a test that did that would run on every ordinary gate. What IS
 * tested is everything that can go wrong without spending thirteen runs to find
 * out: an anchor that no longer resolves, a mutation that is a no-op, an id that
 * collides, a subject that is a test file.
 *
 * The first of those is the one that matters. The six anchors are exact literals
 * in files that change; a subject edited by ordinary work silently turns its
 * pair into `applied: false`, and "the control held" would be indistinguishable
 * from "the mutation was never there" (R35). This file makes that a red test on
 * the day the subject moves, not a surprise at the seal.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { REGISTRY, applyMutation, blobSha, reduceReport } from "../scripts/b12-mutate.mjs";
import { CONTROL_TESTS } from "../src/cost/b12/audit.js";

const repoFile = (rel: string): Promise<string> => fs.readFile(path.join(process.cwd(), rel), "utf8");

describe("the clause-6 mutation registry", () => {
  it("registers exactly the controls clause 6 lists, and no others", () => {
    const key = (c: { file: string; fullName: string }): string => JSON.stringify([c.file, c.fullName]);
    expect(new Set(REGISTRY.map((r) => key(r.control)))).toEqual(new Set(CONTROL_TESTS.map(key)));
    expect(REGISTRY).toHaveLength(CONTROL_TESTS.length);
  });

  it("carries unique ids — two pairs cannot consume one report", () => {
    expect(new Set(REGISTRY.map((r) => r.id)).size).toBe(REGISTRY.length);
  });

  it("anchors every mutation at EXACTLY the declared occurrence count", async () => {
    for (const entry of REGISTRY) {
      const text = await repoFile(entry.subject.path);
      const count = text.split(entry.subject.find).length - 1;
      expect(
        count,
        `${entry.id}: the anchor in ${entry.subject.path} resolves ${count} time(s), not ${entry.subject.occurrences} — the subject moved and the pair would silently not apply`
      ).toBe(entry.subject.occurrences);
    }
  });

  it("mutates production code, never the suite that judges it", () => {
    // R38#1 condition 5: a mutant built from the test's own fixture proves
    // nothing. The coarse, checkable form of that is that no subject is a test.
    for (const entry of REGISTRY) {
      expect(entry.subject.path.startsWith("tests/"), `${entry.id} mutates a test file`).toBe(false);
    }
  });

  it("labels every pair historical or invariant — a reader judging a replay is owed the difference", () => {
    // R40#2: m5 was published as a historical replay of "first-wins" while the
    // mutation actually produced count-both. The mutation stands; the CLAIM had
    // to change, and the label is what makes such a claim checkable at all.
    for (const entry of REGISTRY) {
      expect(["historical", "invariant"], entry.id).toContain(entry.kind);
    }
  });

  it("never registers a no-op — a mutation equal to its anchor would apply and never fire", () => {
    for (const entry of REGISTRY) {
      expect(entry.subject.replace, entry.id).not.toBe(entry.subject.find);
      expect(entry.why.length, `${entry.id} carries no reason a reader could judge`).toBeGreaterThan(20);
    }
  });
});

describe("blobSha", () => {
  it("hashes the committed blob's RAW bytes, trailing newline included", async () => {
    // R40#3: this went through a git helper that trimEnd()s stdout, and every
    // one of these files ends in a newline — so the recorded digest already
    // disagreed with the blob it claimed to name, before line endings were even
    // considered. The artifact's byte-level binding rested on that digest.
    const rel = "scripts/b12-firing.mjs";
    const committed = await repoFile(rel); // CRLF on this checkout, LF in git
    const trimmed = createHash("sha256").update(committed.trimEnd()).digest("hex");
    const digest = blobSha(process.cwd(), "HEAD", rel);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest, "the digest must not be the trimmed-text one the defect produced").not.toBe(trimmed);
  });

  it("returns null for a path the commit does not carry", () => {
    expect(blobSha(process.cwd(), "HEAD", "no/such/file.ts")).toBeNull();
  });
});

describe("applyMutation", () => {
  const scratch = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "b12-mut-test-"));

  it("applies an exact literal and is exactly reversible", async () => {
    const dir = await scratch();
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const rel = "src/x.ts";
    const before = "const a = 1;\nconst b = 2;\n";
    await fs.writeFile(path.join(dir, rel), before, "utf8");

    const out = applyMutation(dir, { path: rel, find: "const b = 2;", replace: "const b = 3;", occurrences: 1 });
    expect(out.applied).toBe(true);
    expect(await fs.readFile(path.join(dir, rel), "utf8")).toBe("const a = 1;\nconst b = 3;\n");

    await fs.writeFile(path.join(dir, rel), before, "utf8");
    expect(await fs.readFile(path.join(dir, rel), "utf8")).toBe(before);
  });

  it("REFUSES when the anchor count differs, and leaves the file untouched", async () => {
    const dir = await scratch();
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const rel = "src/x.ts";
    const before = "dup();\ndup();\n";
    await fs.writeFile(path.join(dir, rel), before, "utf8");

    const out = applyMutation(dir, { path: rel, find: "dup();", replace: "gone();", occurrences: 1 });
    expect(out.applied).toBe(false);
    if (!out.applied) expect(out.notApplied).toContain("2 occurrence(s)");
    expect(await fs.readFile(path.join(dir, rel), "utf8")).toBe(before);
  });

  it("REFUSES an anchor that resolves zero times — R35's mutant that never applied", async () => {
    const dir = await scratch();
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/x.ts"), "nothing here\n", "utf8");
    const out = applyMutation(dir, { path: "src/x.ts", find: "absent", replace: "x", occurrences: 1 });
    expect(out.applied).toBe(false);
    if (!out.applied) expect(out.notApplied).toContain("0 occurrence(s)");
  });

  it("REFUSES a subject that is not in the tree", async () => {
    const dir = await scratch();
    const out = applyMutation(dir, { path: "src/gone.ts", find: "a", replace: "b", occurrences: 1 });
    expect(out.applied).toBe(false);
    if (!out.applied) expect(out.notApplied).toContain("does not exist");
  });
});

describe("reduceReport — the report the artifact can be checked against", () => {
  // THE THIRD OF THREE OMISSIONS the PHASE 0 closure record owed before a
  // scored run: the firing artifact asserted an outcome per pair and carried
  // nothing a reader could recompute it from. This is what it carries now, and
  // the property that matters is that ABSENCE survives the reduction — because
  // `evaluate` treats a control the report never mentions as `unanswerable`,
  // and `notPassed` lists neither a pass nor an absence.
  const CONTROLS = [
    { file: "tests/cost-meter.test.ts", fullName: "suite alpha" },
    { file: "tests/cost-meter.test.ts", fullName: "suite beta" },
  ];
  const report = (root: string) => ({
    numTotalTests: 3,
    numFailedTests: 1,
    numFailedTestSuites: 1,
    testResults: [
      {
        name: `${root}/tests/cost-meter.test.ts`,
        assertionResults: [
          { fullName: "suite alpha", status: "failed" },
          { fullName: "unrelated one", status: "passed" },
          { fullName: "unrelated two", status: "skipped" },
        ],
      },
    ],
  });

  it("keeps every non-passed test, the totals, and a digest of the bytes", () => {
    const root = "C:/tmp/tree";
    const out = reduceReport(report(root), root, CONTROLS);
    expect(out).not.toBeNull();
    expect(out!.totals).toEqual({
      tests: 3,
      suites: 1,
      reportedTotal: 3,
      reportedFailed: 1,
      reportedFailedSuites: 1,
    });
    // Paths are made repo-relative, so the digest set does not carry a
    // machine's temp directory into committed evidence.
    expect(out!.notPassed).toEqual([
      { file: "tests/cost-meter.test.ts", fullName: "suite alpha", status: "failed" },
      { file: "tests/cost-meter.test.ts", fullName: "unrelated two", status: "skipped" },
    ]);
    // A SKIPPED test is kept. It is not a failure and it is not a pass, and the
    // off-diagonal sweep is entitled to see it.
    expect(out!.notPassed.some((t) => t.status === "skipped")).toBe(true);
    expect(out!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a registered control that the report never mentions as ABSENT", () => {
    const root = "C:/tmp/tree";
    const out = reduceReport(report(root), root, CONTROLS);
    const beta = out!.registeredControls.find((c) => c.fullName === "suite beta");
    // `suite beta` is in no assertionResults array anywhere in the payload.
    // Without this field the reduction could not tell a reader whether the
    // control passed or was never run, which is exactly the distinction
    // `evaluate` turns into an `unanswerable` problem.
    expect(beta?.status).toBe("absent");
    expect(out!.registeredControls.find((c) => c.fullName === "suite alpha")?.status).toBe("failed");
    // And absence is NOT inferable from `notPassed`, which is the reason the
    // field exists rather than being derived at read time.
    expect(out!.notPassed.some((t) => t.fullName === "suite beta")).toBe(false);
  });

  it("is null for a payload that is not a report at all", () => {
    expect(reduceReport(null, "C:/tmp/tree", CONTROLS)).toBeNull();
    expect(reduceReport("not an object", "C:/tmp/tree", CONTROLS)).toBeNull();
  });
});
