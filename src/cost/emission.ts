/**
 * THE EMISSION WRAPPER — the one module that owns `gate`'s and `repair`'s
 * telemetry lifecycle: writer selection, the write-once rule, the
 * internal-gate suppression pair, and both emission forms, normal and abort.
 *
 * WHY THIS MODULE EXISTS. B12's `voidConditions` 5 voids a run when "gate's or
 * repair's telemetry emission" changes after the first scored observation, and
 * the clause 4–6 audit checks a PATH SET for post-freeze edits. The tool files
 * themselves must stay editable — they are what the experiment measures, not
 * what it freezes — so the emission lifecycle lives HERE, under `src/cost/**`
 * where the audit's pin already reaches, and the tools call in. The extraction
 * is lawful only because it is behavior-preserving, and the proof is the
 * conformity matrix (`tests/emission-matrix.test.ts`): every lifecycle cell
 * pinned before the extraction and held byte-shape-identical across it.
 *
 * THE STATE MACHINE. `not-started` covers a tool's ENTIRE preflight and emits
 * NOTHING — a refused preflight gets no abort row, on either tool, and not
 * even the log file may appear. `active` begins when the preflight is
 * ACCEPTED — in `gate`, before the check/budget loop, because an exhausted
 * budget still emits a row with zero checks executed, so "before the first
 * check side effect" is a moment that path never reaches — and `active` emits
 * EXACTLY ONE row: the normal one, or the abort one, whichever its path
 * produces first. `startEmission` is the transition; the handle it returns is
 * the whole of `active`'s contract.
 */

import { createCorpusWriter, type CorpusDeps, type CorpusWriter } from "../corpus.js";
import {
  createTelemetryWriter,
  type TelemetryRecord,
  type TelemetryWriter,
} from "../telemetry.js";

/** The writer a tool call emits through: the caller's, or the real one. */
export function selectTelemetryWriter(root: string, provided?: TelemetryWriter): TelemetryWriter {
  return provided ?? createTelemetryWriter(root);
}

/** Same rule for the corpus: injection wins, the project root otherwise. */
export function selectCorpusWriter(
  root: string,
  deps: CorpusDeps,
  provided?: CorpusWriter
): CorpusWriter {
  return provided ?? createCorpusWriter(root, deps);
}

/**
 * The EXACT no-op pair for INTERNAL gate runs — `repair`'s loop calls `gate`
 * once per round over what is substantially ONE failure, and those inner runs
 * may neither write telemetry rows (double-counting would inflate the saving;
 * the repair call is the unit of work) nor archive corpus entries (near
 * duplicates of a single task would quietly weight the corpus toward whatever
 * `repair` was slowest to fix).
 *
 * NO-OP OBJECTS, NEVER `null`/`undefined`: `runGate` falls back to the REAL
 * writers on a nullish dep, so "passing nothing" would give every inner round
 * a row of its own — the exact inflation this pair exists to prevent.
 */
export function innerGateWriters(): { telemetry: TelemetryWriter; corpus: CorpusWriter } {
  return {
    telemetry: { record: async () => {} },
    corpus: { capture: async () => null },
  };
}

/** What `active` may do: one emission, normal or abort, never both. */
export interface EmissionHandle {
  /** True once a row was CLAIMED — the abort path reads it, nothing sets it back. */
  readonly written: boolean;
  /**
   * The one normal emission. The claim lands BEFORE the write, so a throw
   * inside the write itself cannot let the abort path add a second row.
   */
  emit(row: Omit<TelemetryRecord, "ts">): Promise<void>;
  /** The abort emission: a no-op when the normal row was already claimed. */
  abort(row: Omit<TelemetryRecord, "ts">): Promise<void>;
}

/**
 * THE TRANSITION `not-started` → `active`. Call it immediately after a tool's
 * preflight ACCEPTS — never earlier (a refused preflight emits nothing) and
 * never later (a path can emit before its first check side effect).
 */
export function startEmission(telemetry: TelemetryWriter): EmissionHandle {
  let written = false;
  return {
    get written(): boolean {
      return written;
    },
    async emit(row) {
      written = true;
      await telemetry.record(row);
    },
    async abort(row) {
      if (written) return;
      written = true;
      await telemetry.record(row);
    },
  };
}
