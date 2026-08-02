import { promises as fs } from "node:fs";
import path from "node:path";

import { log } from "./logger.js";

/**
 * Append-only record of what each tool call actually saved, written next to the
 * project so `scripts/cost-meter.ts` can join it against the Claude Code
 * transcript.
 *
 * This exists because the interesting quantity is a counterfactual — "what
 * would this have cost had the tool not run" — and only the tool knows the
 * raw size it suppressed or the number of local rounds it absorbed. The
 * transcript alone cannot see either.
 */
export interface TelemetryRecord {
  /** ISO timestamp. A fallback join key only — see `invocation_id`. */
  ts: string;
  /**
   * Unique per tool call, and echoed in the tool's own returned payload. That
   * payload is what Claude Code stores as `toolUseResult`, so the meter can join
   * a telemetry row to the exact transcript entry that produced it.
   *
   * Timestamps alone cannot do this: two sessions on the same project that
   * overlap — or merely run a minute apart — select each other's rows and count
   * the same saving twice. Absent only in rows written before this existed.
   */
  invocation_id?: string;
  tool: string;
  /** Bytes the underlying operation produced before any capping. */
  bytes_raw: number;
  /** Bytes actually returned to Claude — what entered the context. */
  bytes_returned: number;
  /**
   * Local iterations that would each have been a Claude turn. This is the
   * turn-collapse lever, and it is worth more than byte suppression because it
   * shrinks `T` for every token already resident in the context.
   */
  turns_collapsed: number;
  latency_ms: number;
  detail?: Record<string, unknown>;
}

export const TELEMETRY_REL_PATH = path.join(".local-coder", "telemetry.jsonl");

export interface TelemetryWriter {
  record(entry: Omit<TelemetryRecord, "ts">): Promise<void>;
}

/**
 * A writer that appends one JSON line per call and NEVER throws: telemetry is
 * bookkeeping, and a full disk or a read-only checkout must not turn a working
 * tool call into an error.
 */
export function createTelemetryWriter(root: string, now: () => Date = () => new Date()): TelemetryWriter {
  const file = path.join(root, TELEMETRY_REL_PATH);
  return {
    async record(entry) {
      const line: TelemetryRecord = { ts: now().toISOString(), ...entry };
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
      } catch (error) {
        log.warn(
          `telemetry write failed (continuing): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}

/** Read the telemetry log. A missing file is an empty log, not an error. */
export async function readTelemetry(root: string): Promise<TelemetryRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, TELEMETRY_REL_PATH), "utf8");
  } catch {
    return [];
  }
  const out: TelemetryRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as TelemetryRecord;
      if (typeof parsed.ts === "string" && typeof parsed.tool === "string") out.push(parsed);
    } catch {
      // A partially written last line is expected while a tool is running.
    }
  }
  return out;
}
