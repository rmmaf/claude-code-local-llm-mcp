import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { makeTempRoot } from "./helpers.js";

/**
 * B19's oracle, and specifically the claims that would otherwise rot.
 *
 * The first version of `scripts/session-token-walk.mjs` shipped a disjointness
 * invariant that COULD NOT FAIL: per-source uuid sets were filled after the
 * de-duplication guard, so a uuid present in both a main and a subagent file was
 * recorded against main alone and the subagent occurrence was dropped as a
 * duplicate. It reported `sharedUuids: 0` on a corpus built to violate it, while
 * silently discarding that subagent's request — the same failure as the meter
 * printing `(N main, 0 subagent)`, which reads as a measurement and is a gap.
 *
 * So the load-bearing test here is the NEGATIVE control: a corpus where the
 * invariant must come back false. An invariant never shown to fail is not
 * evidence, and B19's `Holds if` is written on this check.
 */
const execFileAsync = promisify(execFile);
const ORACLE = path.join(import.meta.dirname, "..", "scripts", "session-token-walk.mjs");
const SID = "11111111-2222-3333-4444-555555555555";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

function record(
  uuid: string,
  requestId: string,
  usage: Usage,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    requestId,
    sessionId: SID,
    version: "2.1.219",
    message: { model: "claude-opus-5", stop_reason: "end_turn", usage },
    ...extra,
  });
}

/** Writes a session: the main transcript plus optional files under subagents/. */
async function corpus(main: string[], subagents: Record<string, string[]> = {}): Promise<string> {
  const dir = makeTempRoot("token-walk-");
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), `${main.join("\n")}\n`, "utf8");
  for (const [rel, lines] of Object.entries(subagents)) {
    const abs = path.join(dir, SID, "subagents", rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `${lines.join("\n")}\n`, "utf8");
  }
  return dir;
}

async function walk(dir: string): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [
    ORACLE,
    "walk",
    `--dir=${dir}`,
    `--session=${SID}`,
    "--json",
  ]);
  return JSON.parse(stdout).sessions[0];
}

const U = (n: number): string => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("session-token-walk", () => {
  it("FAILS its disjointness invariant when one uuid occurs in both a main and a subagent file", async () => {
    const shared = U(1);
    const dir = await corpus(
      [record(shared, "req-main-1", { output_tokens: 50 }), record(U(2), "req-main-2", { output_tokens: 60 })],
      { "agent-deadbeef.jsonl": [record(shared, "req-sub-1", { output_tokens: 70 }), record(U(3), "req-sub-2", { output_tokens: 80 })] }
    );
    const session = await walk(dir);

    // The point of the test. Before the fix this came back holds:true, sharedUuids:0.
    expect(session.uuidDisjoint.holds).toBe(false);
    expect(session.uuidDisjoint.sharedUuids).toBe(1);
    // Both sides must count the occurrence, or the two set sizes hide it again.
    expect(session.uuidDisjoint.mainUuids).toBe(2);
    expect(session.uuidDisjoint.subagentUuids).toBe(2);
    // And the cost of the collision is visible rather than absorbed: the
    // duplicate record is dropped, so req-sub-1's 70 output tokens are gone.
    expect(session.records.uuidDuplicatesDropped).toBe(1);
    expect(session.tokens.output).toBe(50 + 60 + 80);
  });

  it("holds the invariant on a corpus with no collision, so the check is not stuck on false", async () => {
    const dir = await corpus([record(U(1), "req-main-1", { output_tokens: 10 })], {
      "agent-beef.jsonl": [record(U(2), "req-sub-1", { output_tokens: 20 })],
    });
    const session = await walk(dir);
    expect(session.uuidDisjoint.holds).toBe(true);
    expect(session.uuidDisjoint.sharedUuids).toBe(0);
    expect(session.requests).toMatchObject({ total: 2, main: 1, subagent: 1 });
  });

  it("takes the LAST record of a requestId group, not the first", async () => {
    // The shape src/cost/transcript.ts:239-243 gets wrong: intermediate records
    // carry a partial completion count and the terminal one carries the answer.
    const dir = await corpus([
      record(U(1), "req-1", { output_tokens: 5, cache_read_input_tokens: 30_034 }),
      record(U(2), "req-1", { output_tokens: 5, cache_read_input_tokens: 30_034 }),
      record(U(3), "req-1", { output_tokens: 695, cache_read_input_tokens: 30_034 }),
    ]);
    const session = await walk(dir);

    expect(session.requests.total).toBe(1);
    expect(session.tokens.output).toBe(695);
    // Not summed either — the usage repeats, it does not accumulate.
    expect(session.tokens.cacheRead).toBe(30_034);
    expect(session.diagnostics.groupsWhereFirstDiffersFromLast).toBe(1);
    expect(session.diagnostics.outputLostByFirstWins).toBe(690);
  });

  it("reads cacheWrite from the top-level total and reports the TTL split it contradicts", async () => {
    // 15 real records carry exactly this shape. Taking the larger of the two
    // would put tokens on the oracle's side of a comparison whose other side,
    // once repaired to require consistency, reports the total.
    const dir = await corpus([
      record(U(1), "req-1", {
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 2452, ephemeral_5m_input_tokens: 0 },
      }),
    ]);
    const session = await walk(dir);

    expect(session.tokens.cacheWrite).toBe(0);
    expect(session.diagnostics.ttlSplitDisagreements).toBe(1);
    expect(session.diagnostics.ttlSplitOnlyTokens).toBe(2452);
  });

  it("excludes api-error records by their own fields, never by usage reading zero", async () => {
    const dir = await corpus([
      // Zero usage on a legitimate record: must still be admitted.
      record(U(1), "req-1", { input_tokens: 0, output_tokens: 0 }),
      record(U(2), "req-2", { output_tokens: 9 }, { isApiErrorMessage: true }),
      JSON.stringify({
        type: "assistant",
        uuid: U(3),
        requestId: "req-3",
        sessionId: SID,
        message: { model: "<synthetic>", usage: { output_tokens: 9 } },
      }),
    ]);
    const session = await walk(dir);

    expect(session.records.admitted).toBe(1);
    expect(session.records.excludedApiError).toBe(2);
    expect(session.tokens.output).toBe(0);
  });

  it("admits nothing from a workflows journal, without matching its filename", async () => {
    const dir = await corpus([record(U(1), "req-1", { output_tokens: 11 })], {
      [path.join("workflows", "wf_abc", "agent-1.jsonl")]: [record(U(2), "req-2", { output_tokens: 22 })],
      // Ends in .jsonl, sits inside the session directory, is not a request log.
      [path.join("workflows", "wf_abc", "journal.jsonl")]: [
        JSON.stringify({ type: "result", key: "agent-1", agentId: "a1", value: { usage: { output_tokens: 999 } } }),
      ],
    });
    const session = await walk(dir);

    expect(session.tokens.output).toBe(33);
    const journal = session.files.perFile.find((f: { file: string }) => f.file.endsWith("journal.jsonl"));
    expect(journal?.admitted).toBe(0);
    // The nested workflow agent IS found: that nesting exists in the real corpus.
    expect(session.files.subagents).toHaveLength(2);
  });
});
