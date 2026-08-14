/**
 * ORACLE FOR UNIT 5's PURE CORE — `src/cost/b12/assemble.ts`, over constructed
 * `RunArchive` VALUES. The hostile on-disk cases live in `b12-archive.test.ts`;
 * here every disposition path, every archive-level clause, the selection order,
 * the registered conventions and the F25 handling are functions of literals.
 *
 * Every guard is shown FIRING and shown NOT firing — a check that cannot fail
 * is worse than no check (`DECISIONS.md`), and the F24 pass's oracle style is
 * kept: build ONE coherent default on which NO archive-level check fires —
 * clause 8 went LIVE with F23's repair and the default archive satisfies it —
 * then break exactly one thing per test. The default's void is the
 * ARITHMETIC's own (clause 3: one admitted observation against the frozen 20).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_RATES } from "../src/cost/rates.js";
import { transcriptFromRecords } from "../src/cost/transcript.js";
import type { RawRecord } from "../src/cost/transcript.js";
import type { TelemetryRecord } from "../src/telemetry.js";
import {
  assembleRun,
  committedOrderReplay,
  DISPOSITION_PRECEDENCE,
  instrumentWriteTriggers,
  pacingFacts,
  regimeOf,
  repairRoundsMismatches,
} from "../src/cost/b12/assemble.js";
import { identify } from "../src/cost/b12/coverage.js";
import { isLocalToolResult } from "../src/cost/report.js";
import type {
  ArchivedObservation,
  GitAudit,
  ManifestTask,
  ObservationRecord,
  RunArchive,
  RunlogRow,
} from "../src/cost/b12/types.js";
import {
  archiveOf,
  at,
  billed,
  H64,
  obsOf,
  PINNED,
  recordOf,
  RUN,
  runlogOf,
  SHA40,
  taskOf,
  telemetryRow,
  toolResultRec,
} from "./b12-fixtures.js";

const AUDIT_CLEAN: GitAudit = { ran: true, verdict: "clean", reasons: [], inputs: { head: "abc" } };

// The default actual invocation MATCHES the pin: `voidConditions` 19 fails
// closed on an absent side (the fifth diff round's second finding), so a
// clean default archive must supply the invocation it was scored by.
function assemble(archive: RunArchive, gitAudit: GitAudit = AUDIT_CLEAN, actual: string | null = PINNED.scoringCommand) {
  return assembleRun({ archive, gitAudit, scoringCommandActual: actual });
}

const check = (result: { archiveChecks: { clause: string; fired: boolean; detail: string }[] }, prefix: string) => {
  const found = result.archiveChecks.find((c) => c.clause.startsWith(prefix));
  if (found === undefined) throw new Error(`no archive check starts with "${prefix}"`);
  return found;
};

const cfOf = (out: ReturnType<typeof assembleRun>, taskId: string, attempt = 1) =>
  out.counterfactual.observations.find((o) => o.taskId === taskId && o.attempt === attempt);

// ---------------------------------------------------------------------------

describe("the default archive — one coherent value, and what fires on it", () => {
  it("NO archive check fires — clause 8 is live and satisfied — and the void is the arithmetic's clause 3", () => {
    const out = assemble(archiveOf());
    const fired = out.result.archiveChecks.filter((c) => c.fired);
    expect(fired).toEqual([]);
    // F23 repaired: clause 8 is a LIVE predicate now — present on the face,
    // NOT fired, because the cap is pinned finite-positive and the artifact
    // carries both brackets with four finite bounds.
    const c8 = check(out.result, "voidConditions 8");
    expect(c8.fired).toBe(false);
    expect(c8.detail).toMatch(/both brackets/);
    expect(Number.isFinite(out.result.uncappedBracket.rLo)).toBe(true);
    expect(Number.isFinite(out.result.uncappedBracket.rHi)).toBe(true);
    // With no archive-level void left standing, the verdict falls through to
    // the ARITHMETIC: clause 3 names the 1-of-20 count.
    expect(out.result.verdict).toBe("void");
    expect(out.result.voidClause).toMatch(/^voidConditions 3/);
  });

  it("the single observation is scored, admitted, and its report fields are the hand-derived ones", () => {
    const out = assemble(archiveOf());
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("scored");
    expect(cf.firedPredicates).toEqual([]);
    // One 1,000-token 1h cache write at 2.0x = 2,000 units; O = 310.8 chars /
    // 3.7 × writeComponent(1h) = 84 × 2.0 = 168.
    expect(cf.aO).toBeCloseTo(2_000, 9);
    expect(cf.oO).toBeCloseTo(168, 9);
    expect(cf.aPlusSPositive).toBe(true); // PREMISES § B12: reported, deciding nothing
    expect(cf.perTaskDenominatorShare).toBe(1);
    expect(out.result.rLo).toBeCloseTo((0 - 168) / 2_000, 12);
    expect(out.result.admitted).toBe(1);
  });

  it("perTaskDenominatorShare is the share of the METRIC'S denominator — A + S_lo, never A alone", () => {
    // The seventh round (R7#12): the frozen name is "per-task DENOMINATOR
    // share" and the metric's denominator is A + S — but this computed
    // aO / ΣaO. Two observations with EQUAL A and UNEQUAL S expose the
    // difference: A-only says 0.5 and 0.5; the registered formula
    // (A_t + S_t,lo) / Σ(A + S_lo), deciding lo horizon, does not. A
    // covariate — reported beside the manifest's cap constant, deciding
    // nothing.
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", {
            records: [
              billed("rq-t1", "sess-t1-1", 0, {
                write1h: 1_000,
                content: [{ type: "tool_use", id: "tu-t1", name: "mcp__local-coder__gate" }],
              }),
              toolResultRec("sess-t1-1", "tu-t1", 500, {
                content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }],
              }),
              // The saving is priced against the request FOLLOWING the call —
              // without one, the row cannot credit and S stays 0.
              billed("rq-t1b", "sess-t1-1", 1_000, { write1h: 100 }),
            ],
            telemetry: [telemetryRow(600, { invocation_id: id })],
            record: { originatedRequestIds: ["rq-t1", "rq-t1b"] },
          }),
          obsOf("t2"),
        ],
      })
    );
    const cf1 = cfOf(out, "t1")!;
    const cf2 = cfOf(out, "t2")!;
    // The premise, asserted rather than assumed: t1 credits one collapsed
    // gate call, t2 credits nothing — unequal S parcels.
    expect(cf1.disposition).toBe("scored");
    expect(cf2.disposition).toBe("scored");
    expect(cf1.sLo).toBeGreaterThan(0);
    expect(cf2.sLo).toBe(0);
    // Hand-derived: sLo_1 = (5,000 − 1,000 saved chars) / 3.7 × 2.0 (1h lo).
    const s1 = (4_000 / 3.7) * 2.0;
    expect(cf1.sLo).toBeCloseTo(s1, 9);
    const denom = cf1.aO + s1 + cf2.aO;
    expect(cf1.perTaskDenominatorShare).toBeCloseTo((cf1.aO + s1) / denom, 12);
    expect(cf2.perTaskDenominatorShare).toBeCloseTo(cf2.aO / denom, 12);
    // The A-only formula would put t1's share at aO/(ΣaO); the registered one
    // shifts the S-heavy task's share up, and the shares still sum to 1.
    const aOnlyShare = cf1.aO / (cf1.aO + cf2.aO);
    expect(cf1.perTaskDenominatorShare!).toBeGreaterThan(aOnlyShare + 0.05);
    expect(cf1.perTaskDenominatorShare! + cf2.perTaskDenominatorShare!).toBeCloseTo(1, 12);
  });

  it("the registered conventions are labelled on the artifact, not buried", () => {
    const out = assemble(archiveOf());
    expect(out.result.dispositionPrecedence).toMatch(/REGISTERED CONVENTION/);
    expect(out.result.schema).toBe("b12-result/1");
    expect(out.counterfactual.schema).toBe("b12-counterfactual/1");
  });
});

describe("the disposition table — every predicate FIRING, with its control", () => {
  it("void(execution_error) on a harness outcome, and NOT on completed", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { outcome: "exited_nonzero" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(execution_error)");
    expect(cfOf(assemble(archiveOf()), "t1")!.disposition).toBe("scored");
  });

  it("void(execution_error) when the lineage holds no billed assistant turn", () => {
    const records = [toolResultRec("sess-t1-1", "tu-1", 0, { note: "no billed request here" })];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(execution_error)");
    expect(cfOf(out, "t1")!.firedPredicates.join(" ")).toMatch(/no billed assistant turn/);
  });

  it("censored is an OUTCOME, not an error — the observation stays scored", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { censored: true, outcome: "censored" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
  });

  it("void(version_drift) against the pinned version, and clause 7 reports it", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binaryVersion: "2.1.222" } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(version_drift)");
    expect(check(out.result, "voidConditions 7").fired).toBe(true);
  });

  it("void(version_drift) FAILS CLOSED on absent binary evidence — the sixth round's second finding", () => {
    // An archived binary that cannot SHOW its version or sha against an
    // existing pin is not the pinned binary; the harness never writes an
    // observation without both, so absence is a partial or tampered archive.
    const noVersion = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binaryVersion: null } })] })
    );
    expect(cfOf(noVersion, "t1")!.disposition).toBe("void(version_drift)");
    expect(cfOf(noVersion, "t1")!.firedPredicates.join(" ")).toMatch(/no binary version/);
    const noSha = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binarySha256: null } })] })
    );
    expect(cfOf(noSha, "t1")!.disposition).toBe("void(version_drift)");
    expect(cfOf(noSha, "t1")!.firedPredicates.join(" ")).toMatch(/no binary sha256/);
    // both absent: BOTH named — the sides are compared independently
    const neither = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binaryVersion: null, binarySha256: null } })] })
    );
    const detail = cfOf(neither, "t1")!.firedPredicates.join(" ");
    expect(detail).toMatch(/no binary version/);
    expect(detail).toMatch(/no binary sha256/);
  });

  it("the version comparison replays the harness's own gate — raw `claude --version` output CARRIES the pin", () => {
    // `assertPinned` records the raw version string and requires it to
    // contain the pin; a stricter equality here would fire on every lawful
    // run — the two-implementations drift this repository documents.
    const raw = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { binaryVersion: "2.1.221 (Claude Code)" } })] })
    );
    expect(cfOf(raw, "t1")!.disposition).toBe("scored");
    expect(check(raw.result, "voidConditions 7").fired).toBe(false);
  });

  it("void(instrument_write) when a tool_use touches the telemetry log — run-level via clause 9", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "cat .local-coder/telemetry.jsonl" } },
        ],
      }),
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(instrument_write)");
    expect(check(out.result, "voidConditions 9").fired).toBe(true);
    // control: an innocuous command scans clean
    expect(instrumentWriteTriggers([billed("r", "s", 0, { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "npx tsc --noEmit" } }] })])).toEqual([]);
    // Windows spelling is normalised before matching
    expect(
      instrumentWriteTriggers([
        billed("r", "s", 0, { content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "C:\\repo\\.local-coder\\telemetry.jsonl" } }] }),
      ])
    ).toEqual([".local-coder/telemetry.jsonl"]);
  });

  it("void(rate_key_mixed) when the window's OWN requests span two keys", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, { write1h: 1_000 }),
      billed("rq-t1b", sessionId, 1_000, { write1h: 100, model: "other-model" }),
    ];
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { records, record: { originatedRequestIds: ["rq-t1", "rq-t1b"] } })],
      })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(rate_key_mixed)");
  });

  it("void(withheld) fires on provenanceUnavailable ONLY", () => {
    // A local tool result with NO invocation id anywhere: localResults > 0,
    // byInvocation empty — report.ts's own predicate, quoted by admissionRule 5.
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(sessionId, "tu-1", 500, { content: [{ type: "text", text: "gate output, no id echoed" }] }),
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(withheld)");
  });

  it("ambiguous > 0 does NOT void — admissionRule 6 admits it to the fall arithmetic, hold-excluded", () => {
    // THE DEFENDED READING (plan gate R4): one invocation id echoed by two
    // lineages is ambiguous; the observation stays `scored` and is excluded
    // from the hold arithmetic inside `aggregate` — a void here would drop it
    // from the fall bounds, which rule 6 forbids in its own words.
    const id = "aaaaaaaa-1111-2222-3333-444444444444";
    const lineage = (taskId: string, ms: number): RawRecord[] => [
      billed(`rq-${taskId}`, `sess-${taskId}-1`, ms, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: `tu-${taskId}`, name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(`sess-${taskId}-1`, `tu-${taskId}`, ms + 500, {
        content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }],
      }),
    ];
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { records: lineage("t1", 0), telemetry: [telemetryRow(600, { invocation_id: id })] }),
          obsOf("t2", { records: lineage("t2", 500_000) }),
        ],
      })
    );
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("scored");
    expect(cf.holdExcluded).toBe(true);
  });

  it("void(sibling_inheritance) when an originated id sits in the cumulative union", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1"),
          obsOf("t2", {
            records: [billed("rq-t1", "sess-t2-1", 200_000, { write1h: 100 })],
            record: { originatedRequestIds: ["rq-t1"] },
          }),
        ],
      })
    );
    expect(cfOf(out, "t2")!.disposition).toBe("void(sibling_inheritance)");
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
  });

  it("void(task_failed) against the DECLARED expected exit", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { accepted: false } })] }));
    expect(cfOf(out, "t1")!.disposition).toBe("void(task_failed)");
  });

  it("the 2026-08-14 amendment fires RUN-LEVEL on a max_rounds the manifest did not freeze", () => {
    // THE NEGATIVE CONTROL THE AMENDMENT ITSELF DEMANDS. Its sealingPrecondition
    // forbids registering a run until this test exists and the void is shown
    // FIRING on a fabricated mismatch — an amendment whose rule no code applies
    // is the same dead letter that produced it.
    const govern = (governs: boolean): GitAudit => ({
      ran: true,
      verdict: "clean",
      reasons: [],
      inputs: {
        head: "abc",
        "clause5.repairRoundsAmendment.path": "evidence/2026-08-14-b12-amendment-repair-max-rounds.json",
        "clause5.repairRoundsAmendment.governs": governs ? "yes" : "no",
      },
    });
    const row = (maxRounds: number) => ({
      // `at(0)`, NOT a real-world date. The first version of this test hardcoded
      // 2026-08-14 and the check never fired; I blamed ownership — no tool result
      // carrying the row's invocation id — and a review showed the real predicate
      // was the TIMESTAMP: every fixture is stamped from EPOCH = Nov 2023, and
      // `scopeTelemetry` admits an idless row by a ±60 s window around the
      // observation's requests, so a row three years away is outside the window
      // whatever its ownership. Diagnosing that from one failing assertion,
      // without isolating, is the error this comment exists to keep visible.
      ts: at(0),
      tool: "repair",
      latency_ms: 1,
      bytes_raw: 0,
      bytes_returned: 0,
      turns_collapsed: 0,
      detail: { max_rounds: maxRounds, budget_seconds: 240 },
    });
    // THE CONTROL THE AMENDMENT'S sealingPrecondition DEMANDS: the void FIRING
    // on a fabricated mismatch. The manifest freezes 3; this ran at 10.
    const mismatched = archiveOf({ observations: [obsOf("t1", { telemetry: [row(10)] })] });
    const fired = check(assemble(mismatched, govern(true)).result, "amendment 2026-08-14");
    expect(fired.fired).toBe(true);
    expect(fired.detail).toMatch(/ran repair at a max_rounds other than the frozen one/);
    expect(fired.detail).toMatch(/max_rounds 10 against a frozen repairMaxRounds of 3/);

    // GOVERNANCE IS THE GATE, and these three DO bind today. An ungoverned run
    // must not fire, and must not print the clean sentence either — "no
    // mismatch" and "the rule was not in force" are two different clean answers,
    // and a clause that prints one when it means the other is how a regime
    // silently changes.
    const ungoverned = check(assemble(mismatched, govern(false)).result, "amendment 2026-08-14");
    expect(ungoverned.fired).toBe(false);
    expect(ungoverned.detail).toMatch(/does not govern this run/);

    // No committed audit is UNKNOWN, and may never be read as passed.
    const unknown = check(assemble(mismatched, { ran: false }).result, "amendment 2026-08-14");
    expect(unknown.fired).toBe(false);
    expect(unknown.detail).toMatch(/regime is UNKNOWN/);

    // THE CASE THE REVIEW FOUND, and the one that actually happens: an audit
    // that RAN but predates the amendment's keys. The clause said UNKNOWN while
    // `uncheckedClauses` — built from `gitAudit.ran` alone — stayed empty, so the
    // verdict went FINAL over a rule nobody had established. It must now appear
    // as unchecked, WITHOUT firing: an unproven rule may not kill a run any more
    // than it may bless one.
    const stale = assemble(mismatched, { ran: true, verdict: "clean", reasons: [], inputs: { head: "abc" } }).result;
    expect(check(stale, "amendment 2026-08-14").fired).toBe(false);
    expect(check(stale, "amendment 2026-08-14").detail).toMatch(/regime is UNKNOWN/);
    expect(stale.uncheckedClauses.some((c) => /repairRoundsAmendment\.governs/.test(c))).toBe(true);
    // Control: an audit that DOES carry the key leaves the list clean, so the
    // assertion above cannot be passing because the list is never empty.
    expect(assemble(mismatched, govern(true)).result.uncheckedClauses).toHaveLength(0);

    // A GOVERNED run with nothing to report reaches the clean sentence, so the
    // clause is on the face in every regime rather than appearing only when it
    // fires — the courtesy every other clause here gets.
    const matched = archiveOf({ observations: [obsOf("t1", { telemetry: [row(3)] })] });
    const clean = check(assemble(matched, govern(true)).result, "amendment 2026-08-14");
    expect(clean.fired).toBe(false);
    expect(clean.detail).toMatch(/ran at its task's frozen max_rounds/);
  });

  it("a regime key that is PRESENT but not yes/no is UNKNOWN, never 'does not govern'", () => {
    // THE DEFECT THIS COVERS. The clause tested `=== "yes"` for governance and
    // `=== undefined` for unknown, so every value in between — a plausible
    // `"true"`, a case slip, an empty string, a raw boolean, a future encoding —
    // fell into the `!governs` branch and printed the CONFIDENT sentence "does
    // not govern this run". A value nobody can interpret is not evidence that
    // the amendment is inapplicable; it is evidence the question went unanswered,
    // and answering it permissively is what `uncheckedClauses` exists to stop.
    //
    // The old test only ever supplied "yes" and "no", so this whole space was
    // uncovered — which is why the gap survived its own negative control.
    const withGoverns = (raw: unknown): GitAudit => ({
      ran: true,
      verdict: "clean",
      reasons: [],
      inputs: {
        head: "abc",
        "clause5.repairRoundsAmendment.path": "evidence/2026-08-14-b12-amendment-repair-max-rounds.json",
        "clause5.repairRoundsAmendment.governs": raw,
      } as unknown as Record<string, string>,
    });
    const row = (maxRounds: number) => ({
      ts: at(0),
      tool: "repair",
      latency_ms: 1,
      bytes_raw: 0,
      bytes_returned: 0,
      turns_collapsed: 0,
      detail: { max_rounds: maxRounds, budget_seconds: 240 },
    });
    const mismatched = archiveOf({ observations: [obsOf("t1", { telemetry: [row(10)] })] });

    for (const bad of ["true", "YES", "Yes", "", "1", "no ", true, 0, null]) {
      const out = assemble(mismatched, withGoverns(bad)).result;
      const c = check(out, "amendment 2026-08-14");
      expect(c.fired, `${JSON.stringify(bad)} must not fire`).toBe(false);
      expect(c.detail, `${JSON.stringify(bad)} must read UNKNOWN`).toMatch(/regime is UNKNOWN/);
      expect(c.detail, `${JSON.stringify(bad)} must not claim non-governance`).not.toMatch(/does not govern/);
      // And it may not be published FINAL over a rule nobody established.
      expect(out.uncheckedClauses.some((x) => /repairRoundsAmendment\.governs/.test(x))).toBe(true);
      expect(out.final).toBe(false);
    }

    // THE TWO CONTROLS, so the loop above cannot be passing because everything
    // reads UNKNOWN. Only the exact strings audit.ts writes are interpreted.
    const yes = assemble(mismatched, withGoverns("yes")).result;
    expect(check(yes, "amendment 2026-08-14").fired).toBe(true);
    expect(yes.uncheckedClauses).toHaveLength(0);
    const no = assemble(mismatched, withGoverns("no")).result;
    expect(check(no, "amendment 2026-08-14").detail).toMatch(/does not govern this run/);
    expect(no.uncheckedClauses).toHaveLength(0);
  });

  it("regimeOf: the three readings, and that absent and invalid are the same one", () => {
    expect(regimeOf({ k: "yes" }, "k")).toBe("governs");
    expect(regimeOf({ k: "no" }, "k")).toBe("does-not-govern");
    expect(regimeOf({}, "k")).toBe("unknown");
    expect(regimeOf(null, "k")).toBe("unknown");
    for (const bad of ["true", "YES", "", "1", " no"]) {
      expect(regimeOf({ k: bad }, "k"), bad).toBe("unknown");
    }
  });

  it("repairRoundsMismatches: the comparison itself, away from the scoping", () => {
    // The clause's arithmetic, which the test above cannot reach through the
    // fixture. Both directions are violations: a SMALLER max_rounds is a
    // different condition, not a safer one.
    const r = (detail: Record<string, unknown> | undefined) => ({ tool: "repair", detail });
    expect(repairRoundsMismatches(3, [r({ max_rounds: 3 })])).toHaveLength(0);
    expect(repairRoundsMismatches(3, [r({ max_rounds: 10 })])[0]).toMatch(/max_rounds 10 against a frozen repairMaxRounds of 3/);
    expect(repairRoundsMismatches(3, [r({ max_rounds: 1 })])).toHaveLength(1);
    // Fail-closed on an absent FIELD; silent on an absent ROW.
    expect(repairRoundsMismatches(3, [r({})])[0]).toMatch(/carries no numeric detail\.max_rounds/);
    expect(repairRoundsMismatches(3, [r(undefined)])).toHaveLength(1);
    expect(repairRoundsMismatches(3, [])).toHaveLength(0);
    expect(repairRoundsMismatches(3, [{ tool: "gate", detail: { max_rounds: 99 } }])).toHaveLength(0);
    // A declared value that is not a number leaves nothing to compare against,
    // and silence would be the worst answer available.
    expect(repairRoundsMismatches(null, [r({ max_rounds: 3 })])[0]).toMatch(/nothing to compare against/);
    expect(repairRoundsMismatches(null, [])).toHaveLength(0);
  });

  it("void(pacing) on a gap longer than the shortest TTL in play, and clause 20 reports it", () => {
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, { write1h: 1_000 }),
      billed("rq-t1b", sessionId, 2 * 3_600_000, { write1h: 100 }),
    ];
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { records, record: { originatedRequestIds: ["rq-t1", "rq-t1b"] } })],
      })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("void(pacing)");
    expect(check(out.result, "voidConditions 20").fired).toBe(true);
    // control: ten minutes apart is inside the 1h TTL
    const calm = pacingFacts(
      transcriptFromRecords(
        [billed("a", "s", 0, { write1h: 10 }), billed("b", "s", 600_000, { write1h: 10 })],
        { files: ["/f"], skippedLines: 0, sessionId: "s" }
      ),
      new Set(["a", "b"]),
      DEFAULT_RATES,
      1
    );
    expect(calm.exceeded).toBeNull();
  });

  it("not_started is lawful and reported with its disposition", () => {
    const out = assemble(archiveOf({ tasks: [taskOf("t1"), taskOf("t2")], observations: [obsOf("t1")] }));
    expect(out.result.dispositions).toContainEqual({ taskId: "t2", arm: "treatment", disposition: "not_started" });
  });

  it("precedence is the registered order, and EVERY fired predicate is published", () => {
    // exited_nonzero AND accepted false: execution_error precedes task_failed in
    // the closed list's published order, and both matches are on the face.
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { outcome: "exited_nonzero", accepted: false } })] })
    );
    const cf = cfOf(out, "t1")!;
    expect(cf.disposition).toBe("void(execution_error)");
    expect(cf.firedPredicates.some((p) => p.startsWith("void(task_failed)"))).toBe(true);
    expect(DISPOSITION_PRECEDENCE.indexOf("void(execution_error)")).toBeLessThan(
      DISPOSITION_PRECEDENCE.indexOf("void(task_failed)")
    );
  });
});

describe("F25 at scoring time — reported by name, no disposition minted, nothing thrown", () => {
  it("accepted null with nothing else fired is a declaration failure with NO terms", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { accepted: null } })] }));
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(out.result.declarationFailures[0]!.reasons.join(" ")).toMatch(/F25/);
    expect(cfOf(out, "t1")).toBeUndefined(); // no terms, outside every domain — registered in FINDINGS
    expect(out.result.admitted).toBe(0);
  });

  it("a missing verificationStratum still gets terms, and both declared cells go unevaluable", () => {
    const out = assemble(
      archiveOf({ tasks: [taskOf("t1", { verificationStratum: null })], observations: [obsOf("t1")] })
    );
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(cfOf(out, "t1")).toBeDefined(); // terms exist — the shipped unknownStratum machinery judges
    expect(out.result.strata.testRed.evaluable).toBe(false);
    expect(out.result.strata.typesOnly.evaluable).toBe(false);
  });

  it("a treatment record with no calibrated installedChars is refused terms, never defaulted", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { installedChars: null } })] }));
    expect(cfOf(out, "t1")).toBeUndefined();
    expect(out.result.declarationFailures[0]!.reasons.join(" ")).toMatch(/installedChars/);
  });

  it("an unreadable observation.json is reported, not thrown", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: null })] }));
    expect(out.result.declarationFailures).toHaveLength(1);
    expect(out.result.verdict).toBe("void");
  });
});

describe("admissionRule 12 — re-runs: both archived, both published, one discretionary", () => {
  it("the LAST attempt scores (registered convention) and both fractions are published", () => {
    const out = assemble(
      archiveOf({
        observations: [
          obsOf("t1", { record: { outcome: "exited_nonzero" } }),
          obsOf("t1", { attempt: 2 }),
        ],
      })
    );
    expect(out.result.reruns).toEqual([{ taskId: "t1", arm: "treatment", attempts: 2, scoredAttempt: 2 }]);
    expect(cfOf(out, "t1", 1)).toBeDefined();
    expect(cfOf(out, "t1", 2)).toBeDefined();
    expect(cfOf(out, "t1", 2)!.aPlusSPositive).toBe(true); // admitted
    expect(cfOf(out, "t1", 1)!.aPlusSPositive).toBeNull(); // published, not admitted
    expect(check(out.result, "admissionRule 12").fired).toBe(false);
  });

  it("a second discretionary re-run fires the budget check and the excess is barred", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { record: { outcome: "exited_nonzero" } }),
          obsOf("t1", { attempt: 2 }),
          obsOf("t2", { record: { outcome: "exited_nonzero" } }),
          obsOf("t2", { attempt: 2 }),
        ],
      })
    );
    expect(check(out.result, "admissionRule 12").fired).toBe(true);
    // the second discretionary re-run (t2's, later in run order) is barred
    expect(cfOf(out, "t2", 2)!.aPlusSPositive).toBeNull();
  });

  it("a re-run after void(version_drift) does not consume the discretionary budget", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [
          obsOf("t1", { record: { binaryVersion: "2.1.222" } }),
          obsOf("t1", { attempt: 2 }),
          obsOf("t2", { record: { outcome: "exited_nonzero" } }),
          obsOf("t2", { attempt: 2 }),
        ],
      })
    );
    expect(check(out.result, "admissionRule 12").fired).toBe(false);
    expect(check(out.result, "admissionRule 12").detail).toMatch(/1 discretionary/);
  });
});

describe("selection — the committed order, and the metamorphic pair", () => {
  const manyTasks = (ids: string[]): { tasks: ManifestTask[]; observations: ArchivedObservation[] } => ({
    tasks: ids.map((id) => taskOf(id)),
    observations: ids.map((id) => obsOf(id)),
  });

  it("shuffling the observation array changes NOTHING — the manifest order governs", () => {
    const { tasks, observations } = manyTasks(["t1", "t2", "t3"]);
    const forward = assemble(archiveOf({ tasks, observations }));
    const reversed = assemble(archiveOf({ tasks, observations: [...observations].reverse() }));
    expect(reversed.result.dispositions).toEqual(forward.result.dispositions);
    expect(reversed.result.rLo).toBe(forward.result.rLo);
  });

  it("changing ONLY the manifest order changes which first 20 are selected", () => {
    const ids = Array.from({ length: 21 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
    const { tasks, observations } = manyTasks(ids);
    const a = assemble(archiveOf({ tasks, observations }));
    // t21 first: it displaces t20 from the admitted twenty.
    const rotated = [tasks[20]!, ...tasks.slice(0, 20)];
    const b = assemble(archiveOf({ tasks: rotated, observations, runlogRows: [] }));
    const admittedOf = (out: ReturnType<typeof assembleRun>): string[] =>
      out.counterfactual.observations.filter((o) => o.aPlusSPositive !== null).map((o) => o.taskId);
    expect(admittedOf(a)).toContain("t20");
    expect(admittedOf(a)).not.toContain("t21");
    expect(admittedOf(b)).toContain("t21");
    expect(admittedOf(b)).not.toContain("t20");
    expect(a.result.admitted).toBe(20);
    expect(b.result.admitted).toBe(20);
  });

  it("an invalid observation cannot admit even when every predicate reads scored", () => {
    const out = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { valid: false, invalidReasons: ["drift"] } })] })
    );
    expect(cfOf(out, "t1")!.disposition).toBe("scored");
    expect(cfOf(out, "t1")!.aPlusSPositive).toBeNull(); // not admitted
    expect(out.result.admitted).toBe(0);
  });

  it("a manifest declaring one id twice prices the session ONCE — the seventh adversarial round", () => {
    // Codex's scenario: the selection walks manifest ENTRIES, so a duplicated
    // declaration fetched the same scored attempt twice and counted one
    // session's terms twice while every check stayed clean.
    const dup = assemble(archiveOf({ tasks: [taskOf("t1"), taskOf("t1")], observations: [obsOf("t1")] }));
    const single = assemble(archiveOf({ tasks: [taskOf("t1")], observations: [obsOf("t1")] }));

    const fired = check(dup.result, "design.artifacts 1 — task identity");
    expect(fired.fired).toBe(true);
    expect(fired.detail).toMatch(/declares t1 more than once/);
    expect(dup.result.verdict).toBe("void");

    // The metamorphic half: the duplicate ENTRY may change no figure — one
    // admission, one bracket, one disposition row.
    expect(dup.result.admitted).toBe(1);
    expect(dup.result.admitted).toBe(single.result.admitted);
    expect(dup.result.rLo).toBe(single.result.rLo);
    expect(dup.result.rHi).toBe(single.result.rHi);
    expect(dup.result.dispositions).toEqual(single.result.dispositions);

    // Which declaration governs is REPORTED as undecidable, never defaulted.
    expect(
      dup.counterfactual.declarationFailures.some((f) =>
        f.reasons.some((r) => /declares task t1 more than once/.test(r))
      )
    ).toBe(true);

    // Negative control: unique ids leave the check unfired.
    expect(check(single.result, "design.artifacts 1 — task identity").fired).toBe(false);

    // A duplicated task that never started is ONE not_started row, not two.
    const dupNotStarted = assemble(
      archiveOf({ tasks: [taskOf("t1"), taskOf("t2"), taskOf("t2")], observations: [obsOf("t1")] })
    );
    expect(dupNotStarted.result.dispositions.filter((d) => d.taskId === "t2")).toHaveLength(1);
  });
});

/**
 * VOIDCONDITIONS 2 — the optional-stopping guard, still unimplemented.
 *
 * A predicate WAS written for it on 2026-08-13 and was refuted before shipping:
 * `admitted >= 20 || notStarted === 0`. `runPlan` phase 5 budgets 20-26
 * supervised sessions over a manifest of 30, so 26 observations with 19 admitted
 * and 4 tasks never reached is a LAWFUL run whose set cannot grow — and that
 * predicate voids it, at `emit`, after every session is paid for. It also
 * under-fires: `notStarted` counts tasks with no archived attempt, which is not
 * the question of whether a lawful future event can still change the admitted
 * set. `buildArchiveChecks` carries the full account.
 *
 * These two tests pin the honest state. If a real predicate is ever written,
 * the first one fails, and its neighbours are where to read what the last
 * attempt got wrong.
 */
describe("voidConditions 2 — unimplemented, and no longer claimed", () => {
  const archive = (): Parameters<typeof assemble>[0] =>
    archiveOf({ tasks: [taskOf("t1"), taskOf("t2"), taskOf("t3")], observations: [obsOf("t1")] });

  it("no archive check carries clause 2's number", () => {
    // The whole content of the 2026-08-13 change. Clause 2's number used to sit
    // on `committedOrderReplay` — clause 3's predicate — so an unimplemented
    // clause read as implemented on the artifact's face.
    const claimed = assemble(archive()).result.archiveChecks.filter((c) => c.clause.startsWith("voidConditions 2 "));
    expect(claimed.map((c) => c.clause)).toEqual([]);
  });

  it("the interim bracket IS still derivable — the half of clause 2 nothing closes", () => {
    // NOT AN ENDORSEMENT. This asserts the hole so that closing it is a visible
    // change rather than a silent one. `aggregate` runs before any archive
    // check, so a run stopped at one observation of three still publishes rLo
    // and rHi — the optional-stopping peek the clause forbids.
    const result = assemble(archive()).result;
    expect(typeof result.rLo).toBe("number");
    expect(typeof result.rHi).toBe("number");
  });
});

describe("committedOrderReplay — voidConditions 3's order half, retrospective", () => {
  const tasks = [taskOf("t1"), taskOf("t2"), taskOf("t3")];
  // The session must be the attempt's own — the binding half of clause 3's
  // replay refuses a row it cannot show to be an attempt's row.
  const row = (taskId: string, i: number, attempt = 1): RunlogRow => ({
    ts: at(i * 1_000),
    runId: RUN,
    taskId,
    arm: "treatment",
    sessionId: `sess-${taskId}-${attempt}`,
    outcome: "completed",
    valid: true,
    accepted: true,
    originated: 1,
  });

  it("fires when a task first ran before its predecessor", () => {
    const archive = archiveOf({ tasks, observations: [obsOf("t2")], runlogRows: [row("t2", 0)] });
    expect(committedOrderReplay(archive)).toMatch(/before its predecessor t1/);
    // CLAUSE 3, not clause 2. This predicate was pushed under clause 2's number
    // while nothing implemented clause 2 — this describe block's own title said
    // "voidConditions 3's order half" the whole time.
    expect(check(assemble(archive).result, "voidConditions 3").fired).toBe(true);
  });

  it("a late RE-RUN is not an order event (admissionRule 12 has no temporal clause)", () => {
    const archive = archiveOf({
      tasks,
      observations: [obsOf("t1"), obsOf("t2"), obsOf("t1", { attempt: 2 })],
      runlogRows: [row("t1", 0), row("t2", 1), row("t1", 2, 2)],
    });
    expect(committedOrderReplay(archive)).toBeNull();
  });

  it("fires on a task the committed order does not contain, and on a corrupt runlog", () => {
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1"), obsOf("tX")], runlogRows: [row("t1", 0), row("tX", 1)] })
      )
    ).toMatch(/does not contain/);
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0)], corruptLines: 1 }))
    ).toMatch(/corrupt/);
  });

  it("ABSENT runlog evidence is not compliance — a run with no rows cannot replay its order", () => {
    // The diff review's second finding: an empty runlog passed as clean while
    // the archive held real attempts. Every archived attempt needs its row,
    // and every row its directory.
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [] }))
    ).toMatch(/1 archived attempt\(s\) but 0 runlog row\(s\)/);
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0), row("t2", 1)] })
      )
    ).toMatch(/no observation directory survives/);
  });

  it("the rows must be THESE attempts' rows — the fifth round's session and run bindings", () => {
    // Count equality holds but the row records another session: the
    // correspondence the counts assert is fake, and the replay refuses.
    expect(
      committedOrderReplay(
        archiveOf({
          tasks,
          observations: [obsOf("t1")],
          runlogRows: [{ ...row("t1", 0), sessionId: "sess-somebody-else" }],
        })
      )
    ).toMatch(/no runlog row for t1 records/);
    // A row naming another run is foreign evidence in this run's log.
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [{ ...row("t1", 0), runId: "other-run" }] })
      )
    ).toMatch(/foreign evidence/);
    // An empty sessionId on either side is a binding that cannot be shown.
    expect(
      committedOrderReplay(
        archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [{ ...row("t1", 0), sessionId: "" }] })
      )
    ).toMatch(/cannot be bound to its session/);
    // the negative control: the attempt's own session replays clean
    expect(
      committedOrderReplay(archiveOf({ tasks, observations: [obsOf("t1")], runlogRows: [row("t1", 0)] }))
    ).toBeNull();
  });
});

describe("the archive-level clauses — each fired and each held", () => {
  it("design.artifacts 1 fires on a missing HEAD blob and on a post-start commit", () => {
    const missing = assemble(archiveOf({ git: { manifestBlobSha256: null } }));
    expect(check(missing.result, "design.artifacts 1").fired).toBe(true);
    expect(missing.result.voidClause).toMatch(/^design\.artifacts 1/); // first in table order
    const touched = assemble(archiveOf({ git: { manifestCommitsAfterStart: ["deadbeef"] } }));
    expect(check(touched.result, "design.artifacts 1").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "design.artifacts 1").fired).toBe(false);
  });

  it("voidConditions 4 fires when rates.json drifts from the frozen blob or the pin", () => {
    const drifted = assemble(archiveOf({ ratesSha256: H64("0") }));
    expect(check(drifted.result, "voidConditions 4 — rates").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 4 — rates").fired).toBe(false);
  });

  it("voidConditions 12 fires on a component hash that moved, and on a missing policy blob hash", () => {
    const components = {
      claudeMd: "h-claude",
      memory: "h-mem",
      settings: "h-set",
      settingsLocal: "h-setl",
      mcpConfigPassed: "h-mcp",
      policyBlob: "h-pol",
      allowlist: null,
    };
    const drifted = assemble(
      archiveOf({
        observations: [
          obsOf("t1", {
            record: { instructionHashes: { pre: { ...components }, post: { ...components, settings: "MOVED" } } },
          }),
        ],
      })
    );
    expect(check(drifted.result, "voidConditions 12").fired).toBe(true);
    const missingPolicy = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { policyBlobSha256: null } })] })
    );
    expect(check(missingPolicy.result, "voidConditions 12").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 12").fired).toBe(false);
  });

  it("voidConditions 13 fires on a memory write and on a snapshot that is not the pinned one", () => {
    const components = {
      claudeMd: "h-claude",
      memory: "h-mem",
      settings: "h-set",
      settingsLocal: "h-setl",
      mcpConfigPassed: "h-mcp",
      policyBlob: "h-pol",
      allowlist: null,
    };
    const written = assemble(
      archiveOf({
        observations: [
          obsOf("t1", {
            record: { instructionHashes: { pre: { ...components }, post: { ...components, memory: "WROTE" } } },
          }),
        ],
      })
    );
    expect(check(written.result, "voidConditions 13").fired).toBe(true);
    const wrongSnapshot = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { memorySnapshotSha256: H64("f") } })] })
    );
    expect(check(wrongSnapshot.result, "voidConditions 13").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 13").fired).toBe(false);
  });

  it("voidConditions 14 fires on a missing or zero-count snapshot", () => {
    const missing = assemble(archiveOf({ observations: [obsOf("t1", { snapshotBefore: null })] }));
    expect(check(missing.result, "voidConditions 14").fired).toBe(true);
    const zero = assemble(
      archiveOf({
        observations: [
          obsOf("t1", {
            snapshotBefore: { ts: at(0), identity: null, slugsWalked: 0, files: 0, requestIds: [] },
          }),
        ],
      })
    );
    expect(check(zero.result, "voidConditions 14").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 14").fired).toBe(false);
  });

  it("voidConditions 11 fires when an observation's base commit is not its declared one", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { baseCommit: SHA40("9") } })] }));
    expect(check(out.result, "voidConditions 11").fired).toBe(true);
    expect(check(assemble(archiveOf()).result, "voidConditions 11").fired).toBe(false);
  });

  it("voidConditions 19 compares the scoring command and publishes the ambiguity id set", () => {
    const pinnedCmd = PINNED.scoringCommand;
    const match = assemble(archiveOf(), AUDIT_CLEAN, pinnedCmd);
    expect(check(match.result, "voidConditions 19").fired).toBe(false);
    const differ = assemble(archiveOf(), AUDIT_CLEAN, "node something-else.js");
    expect(check(differ.result, "voidConditions 19").fired).toBe(true);
    expect(match.result.scoringCommand).toEqual({ pinned: pinnedCmd, actual: pinnedCmd });
    expect(Array.isArray(match.result.ambiguityIdSet)).toBe(true);
  });

  it("voidConditions 19 FAILS CLOSED — an absent pin or an unsupplied invocation is never clean", () => {
    // The fifth diff round's second finding: certifying "the registered
    // command scored this run" needs both sides of the comparison.
    const noActual = assemble(archiveOf(), AUDIT_CLEAN, null);
    expect(check(noActual.result, "voidConditions 19").fired).toBe(true);
    expect(check(noActual.result, "voidConditions 19").detail).toMatch(/not supplied/);
    const noPin = assemble(archiveOf({ pinned: { scoringCommand: undefined } }));
    expect(check(noPin.result, "voidConditions 19").fired).toBe(true);
    expect(check(noPin.result, "voidConditions 19").detail).toMatch(/no scoring command is pinned/);
  });

  it("voidConditions 7 and 20 fire when their pins are absent — a sealed manifest carries both", () => {
    const noVersion = assemble(archiveOf({ pinned: { claudeCodeVersion: undefined } }));
    expect(check(noVersion.result, "voidConditions 7").fired).toBe(true);
    const noCeiling = assemble(archiveOf({ pinned: { pacingCacheWriteShareCeiling: undefined } }));
    expect(check(noCeiling.result, "voidConditions 20").fired).toBe(true);
  });

  it("admissionRule 7 sweeps EVERY manifest task's scope — coverage, grammar, and the not_started too", () => {
    // NOT firing: the fixture default (src/tools/) is disjoint from the
    // instrument set — that is why the default narrowed.
    expect(check(assemble(archiveOf()).result, "admissionRule 7").fired).toBe(false);
    // Firing on a task with NO observation: "no manifest task's file scope"
    // is the whole pre-registered list, never only the admitted ones.
    const notStarted = assemble(
      archiveOf({ tasks: [taskOf("t1"), taskOf("t9", { fileScope: ["src/"] })], observations: [obsOf("t1")] })
    );
    const c = check(notStarted.result, "admissionRule 7");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/t9: file scope src\/ intersects the instrument set at src\/cost\/\*\*/);
    // The grammar rejects what it cannot place, and coverage catches the
    // rest: ancestry tricks, absolutes, Windows backslashes into a protected
    // directory, and globs outside a trailing /**.
    for (const scope of ["src/../src/cost/**", "/etc/passwd", "src\\cost\\", "src/*.ts", "evidence/"]) {
      const out = assemble(archiveOf({ tasks: [taskOf("t1", { fileScope: [scope] })] }));
      expect(check(out.result, "admissionRule 7").fired).toBe(true);
    }
  });

  it("voidConditions 8 fires on an absent, zero, negative or infinite cap — the firing half of the live predicate", () => {
    // Literally `!(Number.isFinite(cap) && cap > 0)`, plus a non-finite
    // bracket bound. The NOT-firing half is the default-archive oracle at the
    // top of this file; here the cap goes bad four ways and each one fires.
    const absent = assemble(archiveOf({ pinned: { clientTruncationCap: undefined } }));
    expect(check(absent.result, "voidConditions 8").fired).toBe(true);
    expect(check(absent.result, "voidConditions 8").detail).toMatch(/NO measured clientTruncationCap/);
    const zero = assemble(archiveOf({ pinned: { clientTruncationCap: 0 } }));
    expect(check(zero.result, "voidConditions 8").fired).toBe(true);
    const negative = assemble(archiveOf({ pinned: { clientTruncationCap: -1 } }));
    expect(check(negative.result, "voidConditions 8").fired).toBe(true);
    const infinite = assemble(archiveOf({ pinned: { clientTruncationCap: Number.POSITIVE_INFINITY } }));
    expect(check(infinite.result, "voidConditions 8").fired).toBe(true);
  });
});

describe("the diff review's trust boundaries — absent evidence is never clean", () => {
  it("a suspect telemetry source prices NOTHING: integrity failure, fired check, no terms", () => {
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [obsOf("t1"), { ...obsOf("t2"), telemetryIntact: false, problems: ["telemetry.jsonl carries 1 corrupt line(s)"] }],
      })
    );
    expect(out.result.integrityFailures).toEqual([
      {
        taskId: "t2",
        arm: "treatment",
        attempt: 1,
        reasons: ["the telemetry identity source is not intact", "telemetry.jsonl carries 1 corrupt line(s)"],
      },
    ]);
    expect(check(out.result, "design.artifacts 6").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined(); // no terms from a tampered source
    expect(cfOf(out, "t1")).toBeDefined();
    // the negative control: an intact archive holds the check quiet
    expect(check(assemble(archiveOf()).result, "design.artifacts 6").fired).toBe(false);
  });

  it("cross-wired identity prices NOTHING — the fifth round's first finding", () => {
    // Evidence whose own identity does not bind to the directory it was
    // scored from would apply one task's acceptance and telemetry to another;
    // it is an integrity failure with no terms, never a scored observation.
    const crossWired = obsOf("t2", {
      identityIntact: false,
    });
    crossWired.problems.push("observation.json names t9/treatment while the directory names t2/treatment");
    const out = assemble(
      archiveOf({ tasks: [taskOf("t1"), taskOf("t2")], observations: [obsOf("t1"), crossWired] })
    );
    expect(check(out.result, "design.artifacts 6").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined(); // no terms under a borrowed name
    expect(out.result.integrityFailures).toHaveLength(1);
    expect(out.result.integrityFailures[0]!.reasons.join(" ")).toMatch(/cross-wired or unshowable/);
    expect(out.result.verdict).toBe("void");
    // the negative control: a bound identity computes terms as ever
    expect(cfOf(assemble(archiveOf()), "t1")).toBeDefined();
  });

  it("a record with NO instruction hashes fires clause 12 — unshowable is not clean", () => {
    const out = assemble(archiveOf({ observations: [obsOf("t1", { record: { instructionHashes: null } })] }));
    expect(check(out.result, "voidConditions 12").fired).toBe(true);
    expect(check(out.result, "voidConditions 12").detail).toMatch(/no instruction hashes at all/);
  });

  it("missing memory evidence fires clause 13 in each of its three shapes", () => {
    const noRestoration = assemble(
      archiveOf({ observations: [obsOf("t1", { record: { memorySnapshotSha256: null } })] })
    );
    expect(check(noRestoration.result, "voidConditions 13").fired).toBe(true);
    expect(check(noRestoration.result, "voidConditions 13").detail).toMatch(/no restoration hash/);
    const noPin = assemble(archiveOf({ pinned: { memorySnapshotSha256: undefined } }));
    expect(check(noPin.result, "voidConditions 13").fired).toBe(true);
    expect(check(noPin.result, "voidConditions 13").detail).toMatch(/pins no memory snapshot/);
  });

  it("evidence that differs from HEAD prices nothing — dirty files bar terms and fire the committed-evidence check", () => {
    // The second diff round's first finding: the commit barrier proves the
    // WRITE; the replay must prove the READ. A dirty path is positive
    // evidence of tampering, so the observation loses its terms too.
    const dirtyObs = { ...obsOf("t2"), evidenceCommitted: false };
    const out = assemble(
      archiveOf({
        tasks: [taskOf("t1"), taskOf("t2")],
        observations: [obsOf("t1"), dirtyObs],
        evidenceCommitted: { state: "dirty", dirty: [`evidence/${RUN}/obs-t2-treatment/telemetry.jsonl`] },
      })
    );
    expect(check(out.result, "design.artifacts 6 — committed evidence").fired).toBe(true);
    expect(cfOf(out, "t2")).toBeUndefined();
    expect(out.result.integrityFailures[0]!.reasons.join(" ")).toMatch(/differ from HEAD/);
    // control: a clean state holds the check quiet
    expect(check(assemble(archiveOf()).result, "design.artifacts 6 — committed evidence").fired).toBe(false);
  });

  it("UNSHOWABLE committedness fires the check but does not fabricate a tampering claim — terms still publish", () => {
    const unshowable = { ...obsOf("t1"), evidenceCommitted: null };
    const out = assemble(
      archiveOf({ observations: [unshowable], evidenceCommitted: { state: "unshowable", dirty: [] } })
    );
    expect(check(out.result, "design.artifacts 6 — committed evidence").fired).toBe(true);
    expect(check(out.result, "design.artifacts 6 — committed evidence").detail).toMatch(/UNSHOWABLE/);
    expect(cfOf(out, "t1")).toBeDefined(); // the partial bracket is owed either way
    expect(out.result.verdict).toBe("void");
  });

  it("a manifest whose scored bytes are not HEAD's blob fires artifact 1 — a path proves nothing about bytes", () => {
    const out = assemble(archiveOf({ git: { manifestMatchesHead: false } }));
    const c = check(out.result, "design.artifacts 1");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/NOT HEAD's blob/);
  });

  it("an unestablishable freeze window fires artifact 1 — a freeze that cannot be shown held is not a freeze", () => {
    // The fourth adversarial round: the window was anchored on the runlog
    // row's END-of-observation ts, and a null anchor read as "held".
    const out = assemble(archiveOf({ git: { manifestCommitsAfterStart: null } }));
    const c = check(out.result, "design.artifacts 1");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/freeze window could not be established/);
  });

  it("rates verification fails CLOSED — an absent pin or an unreadable frozen blob is never clean", () => {
    const noFrozen = assemble(archiveOf({ git: { ratesSha256AtFrozenCommit: null } }));
    expect(check(noFrozen.result, "voidConditions 4 — rates").fired).toBe(true);
    expect(check(noFrozen.result, "voidConditions 4 — rates").detail).toMatch(/cannot be SHOWN/);
    const noPin = assemble(archiveOf({ pinned: { ratesSha256: undefined } }));
    expect(check(noPin.result, "voidConditions 4 — rates").fired).toBe(true);
    // the control: with all three hashes present and equal, the check is quiet
    expect(check(assemble(archiveOf()).result, "voidConditions 4 — rates").fired).toBe(false);
  });

  it("a register that cannot be shown complete fires clause 1's check — discrepancies are never mere annotations", () => {
    // The third adversarial round: a locally deleted MEASUREMENTS row turned
    // an abandoned run into a reported-but-deciding-nothing discrepancy.
    const out = assemble(
      archiveOf({
        register: {
          priorRuns: [],
          discrepancies: [
            "evidence/old-run.b12.tasks.json is committed but MEASUREMENTS.jsonl carries no old-run row — registration is conjunctive and this is neither registered nor clean",
          ],
        },
      })
    );
    const c = check(out.result, "voidConditions 1 — the register");
    expect(c.fired).toBe(true);
    expect(c.detail).toMatch(/cannot be shown complete/);
    expect(check(assemble(archiveOf()).result, "voidConditions 1 — the register").fired).toBe(false);
  });

  it("clause 19 compares the derived ambiguity universe against the SEALED invocation inventory", () => {
    // A sealed id the rebuilt transcript no longer carries means a tool result
    // was dropped somewhere — the ambiguity universe silently shrank.
    const out = assemble(
      archiveOf({
        observations: [obsOf("t1", { invocationIds: ["aaaaaaaa-9999-8888-7777-666666666666"] })],
      })
    );
    expect(check(out.result, "voidConditions 19").fired).toBe(true);
    expect(check(out.result, "voidConditions 19").detail).toMatch(/sealed id\(s\) absent/);
  });
});

describe("the clause 4–6 audit — an input, never a silent pass", () => {
  it("{ran: false} leaves clauses 4–6 UNCHECKED on the face, never 'clean'", () => {
    const out = assemble(archiveOf(), { ran: false });
    expect(out.result.uncheckedClauses).toHaveLength(3);
    expect(out.result.uncheckedClauses.join(" ")).toMatch(/voidConditions 5/);
    expect(out.result.gitAudit).toEqual({ ran: false });
  });

  it("a committed audit that returned void fires as a check and names its reasons", () => {
    const out = assemble(archiveOf(), {
      ran: true,
      verdict: "void",
      reasons: ["src/cost/report.ts changed after the first scored observation"],
      inputs: { head: "abc" },
    });
    // Clauses 4–6 are CHECKED — that is what a committed audit buys, and it is
    // what this test is about. The list is no longer empty, and that is not a
    // regression: this fixture's audit predates the 2026-08-14 amendment's keys,
    // so which regime governs repair's frozen max_rounds is genuinely unknown
    // here. Asserted by CONTENT rather than by length, so the next clause to go
    // unchecked cannot slip in under a number.
    expect(out.result.uncheckedClauses.filter((c) => /voidConditions [456]/.test(c))).toHaveLength(0);
    expect(out.result.uncheckedClauses).toEqual([expect.stringMatching(/repairRoundsAmendment\.governs/)]);
    const audit = check(out.result, "voidConditions 4–6");
    expect(audit.fired).toBe(true);
    expect(audit.detail).toMatch(/report\.ts changed/);
  });

  it("a clean audit is on the face and fires nothing", () => {
    const out = assemble(archiveOf(), AUDIT_CLEAN);
    expect(check(out.result, "voidConditions 4–6").fired).toBe(false);
  });
});

describe("control arms and the run-level ledger", () => {
  it("admissionRule 13: control observations never enter the primary arithmetic", () => {
    const controlObs: ArchivedObservation = {
      ...obsOf("t1"),
      arm: "control",
      dir: `evidence/${RUN}/obs-t1-control`,
      record: { ...recordOf("t1", "sess-t1-c"), arm: "control", installedChars: { value: null, reason: "control arm" } },
    };
    const out = assemble(archiveOf({ observations: [obsOf("t1"), controlObs] }));
    expect(out.counterfactual.observations.every((o) => o.arm === "treatment")).toBe(true);
    expect(check(out.result, "admissionRule 13").detail).toMatch(/1 control observation/);
  });

  it("every universe key is accounted for: owned, contested, unsliced or unowned", () => {
    // The assertion that does not go through the units (UNIT-5.md "Done when"):
    // identity is stamped once per archive file, so every physical line appears
    // under ONE key everywhere, and the ledger names what it could not place.
    const id = "bbbbbbbb-1111-2222-3333-444444444444";
    const sessionId = "sess-t1-1";
    const records = [
      billed("rq-t1", sessionId, 0, {
        write1h: 1_000,
        content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
      }),
      toolResultRec(sessionId, "tu-1", 500, {
        content: [{ type: "text", text: JSON.stringify({ invocation_id: id }) }],
      }),
    ];
    const telemetry = [
      telemetryRow(600, { invocation_id: id }),
      telemetryRow(700), // no id — unverifiable, unowned
      telemetryRow(90_000_000), // outside every window — unsliced
    ];
    const out = assemble(archiveOf({ observations: [obsOf("t1", { records, telemetry })] }));
    const coverage = out.result.coverage;
    const universeKeys = telemetry.map((_, i) =>
      JSON.stringify([`evidence/${RUN}/obs-t1-treatment/telemetry.jsonl`, i])
    );
    for (const key of universeKeys) {
      const accounted =
        coverage.ownedBy.has(key) ||
        coverage.contested.some((c) => c.key === key) ||
        coverage.unsliced.includes(key) ||
        coverage.unownedRows.some((r) => r.key === key);
      expect.soft(accounted, `key ${key} vanished from the ledger`).toBe(true);
    }
    expect(coverage.unsliced).toHaveLength(1);
  });

  it("the round trip: the units called by hand produce the same bracket", () => {
    const out = assemble(archiveOf());
    // By hand, not through assemble: one admitted observation, A=2000, S=0,
    // O=168 — poolRatio gives (0-168)/2000 at both horizons.
    expect(out.result.rLo).toBeCloseTo(-0.084, 12);
    expect(out.result.rHi).toBeCloseTo(-0.084, 12);
    expect(out.result.rHiPlus.evaluable).toBe(true);
    if (out.result.rHiPlus.evaluable) expect(out.result.rHiPlus.value).toBeCloseTo(-0.084, 12);
    expect(out.result.recomputations.rLoMinusTask).toBe(0); // largest task dropped → empty set
    expect(out.result.recomputations.rAll).toBeCloseTo(-0.084, 12);
  });
});
