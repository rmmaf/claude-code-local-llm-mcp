/**
 * ORACLE FOR THE CAPTURE — `src/cost/b12/capture.ts`, `design.artifacts` 6.
 *
 * Two halves, because the module has two.
 *
 * The PURE half — `reduceRecord`, `reduceFile`, `lineageIndices` — is pinned
 * over values, and that is where the rules live: which fields survive the
 * reduction, what a malformed line becomes, and which files a lineage contains.
 *
 * The IMPURE half — `captureObservation` — is pinned over a real directory tree,
 * because everything it can get wrong is about the filesystem: reading the wrong
 * telemetry root, missing a project slug, hashing the worktree with `.git` in
 * it, or widening a lineage that matched nothing.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: that any row is credited or
 * refused. The capture classifies nothing — `buildCounterfactual` does, at
 * scoring time — and an assertion here about a disposition would be pinning a
 * second implementation of the join into place.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPTURE_SCHEMA,
  captureObservation,
  lineageIndices,
  reduceFile,
  reduceRecord,
} from "../src/cost/b12/capture.js";
import { scopeTelemetry } from "../src/cost/report.js";
import { readTelemetry, TELEMETRY_REL_PATH } from "../src/telemetry.js";
import { readTranscript, type Transcript } from "../src/cost/transcript.js";
import { makeTempRoot } from "./helpers.js";

const roots: string[] = [];
const tmp = (): string => {
  const root = makeTempRoot("b12-capture-");
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** An assistant line as Claude Code actually writes one: metered fields plus noise. */
const assistantLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "assistant",
  uuid: "u-1",
  sessionId: "s-1",
  requestId: "req-1",
  timestamp: "2026-08-07T10:00:00.000Z",
  parentUuid: null,
  isSidechain: false,
  message: { model: "claude-opus-5", usage: { input_tokens: 10 }, content: [], id: "msg_x", stop_reason: "end_turn" },
  cwd: "/somewhere",
  version: "2.1.219",
  gitBranch: "main",
  userType: "external",
  ...over,
});

const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

// ---------------------------------------------------------------------------

describe("reduceRecord — the reduction is the parser's own field set", () => {
  it("keeps every metered field and drops everything the meter never reads", () => {
    const reduced = reduceRecord(assistantLine());
    expect(reduced).not.toBeNull();
    expect(Object.keys(reduced!).sort()).toEqual(
      ["message", "parentUuid", "requestId", "sessionId", "timestamp", "type", "uuid", "isSidechain"].sort()
    );
    // The four the transcript carries and the meter never looks at.
    for (const noise of ["cwd", "version", "gitBranch", "userType"]) {
      expect(reduced).not.toHaveProperty(noise);
    }
  });

  it("narrows `message` to model/usage/content and drops the rest", () => {
    const reduced = reduceRecord(assistantLine());
    expect(Object.keys(reduced!.message as object).sort()).toEqual(["content", "model", "usage"]);
  });

  it("keeps `toolUseResult` VERBATIM — the meter's number is its serialized length", () => {
    const payload = { stdout: "x".repeat(500), invocation_id: "inv-9", nested: { deep: [1, 2, 3] } };
    const reduced = reduceRecord(assistantLine({ toolUseResult: payload, type: "user" }));
    expect(reduced!.toolUseResult).toEqual(payload);
    // The whole point: the archived object must serialize to the same length the
    // meter would have measured on the original line.
    expect(JSON.stringify(reduced!.toolUseResult).length).toBe(JSON.stringify(payload).length);
  });

  it("ABSENT stays absent — it is not written back as undefined or null", () => {
    const reduced = reduceRecord({ type: "assistant", uuid: "u" });
    expect("requestId" in reduced!).toBe(false);
    expect("parentUuid" in reduced!).toBe(false);
    // A null the record really carried is kept, and is a different fact.
    const withNull = reduceRecord({ type: "assistant", parentUuid: null });
    expect("parentUuid" in withNull!).toBe(true);
    expect(withNull!.parentUuid).toBeNull();
  });

  it("returns null for a non-object rather than an empty record", () => {
    // `{}` would archive as an admitted record carrying nothing.
    expect(reduceRecord(42)).toBeNull();
    expect(reduceRecord("a string")).toBeNull();
    expect(reduceRecord(null)).toBeNull();
    expect(reduceRecord([1, 2])).toBeNull();
  });
});

describe("reduceFile — a malformed line is counted, never fatal and never silent", () => {
  it("counts an unparseable line and a non-object line in the same place", () => {
    const text = `${JSON.stringify(assistantLine())}\n{not json\n7\n\n${JSON.stringify(assistantLine({ uuid: "u-2" }))}\n`;
    const { records, droppedLines } = reduceFile(text);
    expect(records).toHaveLength(2);
    expect(droppedLines).toBe(2);
  });
});

// ---------------------------------------------------------------------------

/** Only the two fields `lineagesOf` and the seed match on. */
const fakeTranscript = (sessionId: string, requestIds: string[]): Transcript =>
  ({
    sessionId,
    requests: requestIds.map((requestId) => ({ requestId })),
  }) as unknown as Transcript;

describe("lineageIndices — the connected component, not the directory", () => {
  it("pulls in a continuation that shares an admitted requestId", () => {
    const all = [
      fakeTranscript("s-1", ["a", "b"]),
      fakeTranscript("s-2", ["b", "c"]), // continues s-1
      fakeTranscript("s-3", ["z"]), // unrelated
    ];
    expect(lineageIndices(all, "s-1")).toEqual([0, 1]);
  });

  it("takes both components when two files carry the seed's own sessionId", () => {
    const all = [fakeTranscript("s-1", ["a"]), fakeTranscript("s-1", ["q"]), fakeTranscript("s-9", ["z"])];
    expect(lineageIndices(all, "s-1")).toEqual([0, 1]);
  });

  it("A SEED THAT MATCHES NOTHING RETURNS NOTHING — never the whole machine", () => {
    const all = [fakeTranscript("s-1", ["a"]), fakeTranscript("s-2", ["b"])];
    // The dangerous alternative is a widened lineage: a denominator that is not
    // the observation's, which is the failure `takeSnapshot` already refuses on.
    expect(lineageIndices(all, "s-absent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

interface Tree {
  treeDir: string;
  slugDir: string;
}

async function tree(files: Record<string, string>, transcripts: Record<string, string>): Promise<Tree> {
  const root = tmp();
  const treeDir = path.join(root, "worktree");
  const slugDir = path.join(root, "projects", "slug-a");
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(treeDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, "utf8");
  }
  await fs.mkdir(slugDir, { recursive: true });
  for (const [name, body] of Object.entries(transcripts)) {
    await fs.writeFile(path.join(slugDir, name), body, "utf8");
  }
  return { treeDir, slugDir };
}

const line = (over: Record<string, unknown>): Record<string, unknown> => assistantLine(over);

describe("captureObservation — the only filesystem surface", () => {
  it("archives the lineage, the telemetry, the ids and the worktree hashes", async () => {
    const telemetry = jsonl({ ts: "2026-08-07T10:00:01.000Z", tool: "gate", invocation_id: "11111111-2222-4333-8444-555555555555", bytes_raw: 40 });
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": "export const a = 1;\n", [TELEMETRY_REL_PATH]: telemetry },
      {
        "own.jsonl": jsonl(
          // THE `tool_use` BLOCK IS LOAD-BEARING AND THIS FIXTURE FIRST OMITTED
          // IT. `isLocalToolResult` matches the tool NAME, which the parser
          // resolves from the assistant record's `tool_use` block by `id` — so
          // without it the result has `name: null`, fails the first hop of the
          // five-hop join (`FINDINGS.md` F10), and `invocationIds` comes back
          // empty. The oracle caught the fixture, which is the only way a
          // fixture that contradicts its own intent ever surfaces.
          line({
            sessionId: "s-own",
            requestId: "r-1",
            uuid: "u-1",
            message: {
              model: "claude-opus-5",
              usage: { input_tokens: 10 },
              content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
            },
          }),
          {
            type: "user",
            uuid: "u-2",
            sessionId: "s-own",
            timestamp: "2026-08-07T10:00:02.000Z",
            message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
            toolUseResult: { invocation_id: "11111111-2222-4333-8444-555555555555", tool: "mcp__local-coder__gate" },
          },
          // A `Read` whose OUTPUT quotes somebody else's invocation id — the
          // exact shape of `FINDINGS.md` F10. Transcript ids are scanned out of
          // arbitrary serialized output, so an echo and a quotation look
          // identical until the tool NAME is checked. Without this row in the
          // fixture, `isLocalToolResult` could be deleted and every assertion
          // here would still pass.
          line({
            sessionId: "s-own",
            uuid: "u-3",
            requestId: "r-1",
            message: {
              model: "claude-opus-5",
              usage: { input_tokens: 5 },
              content: [{ type: "tool_use", id: "tu-2", name: "Read" }],
            },
          }),
          {
            type: "user",
            uuid: "u-4",
            sessionId: "s-own",
            timestamp: "2026-08-07T10:00:03.000Z",
            message: { content: [{ type: "tool_result", tool_use_id: "tu-2" }] },
            toolUseResult: { file: ".local-coder/telemetry.jsonl", text: '{"invocation_id":"99999999-8888-4777-8666-555555555555"}' },
          }
        ),
        "other.jsonl": jsonl(line({ sessionId: "s-other", requestId: "r-9", uuid: "u-9" })),
      }
    );

    const archive = await captureObservation({
      taskId: "t-01",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });

    expect(archive.schema).toBe(CAPTURE_SCHEMA);
    // The unrelated session shares no requestId, so it is not in the lineage.
    expect(archive.lineage.map((l) => l.sessionId)).toEqual(["s-own"]);
    expect(archive.transcriptsSearched).toBe(2);
    expect(archive.slugsSearched).toEqual(["slug-a"]);
    expect(archive.lineage[0]!.requestIds).toEqual(["r-1"]);
    expect(archive.telemetryFound).toBe(true);
    expect(archive.telemetry).toHaveLength(1);
    expect(archive.telemetry[0]!.tool).toBe("gate");
    // ONE id, not two: the `Read` result quotes an id it does not own, and the
    // first hop of the join is the tool name (`isLocalToolResult`).
    expect(archive.invocationIds).toEqual(["11111111-2222-4333-8444-555555555555"]);
    expect(archive.dirtyAtCapture).toBe(false);
  });

  it("the ACCEPTANCE COMMAND's telemetry is not the arm's, and the ±60s window does not save us", async () => {
    // R33. Acceptance runs in the arm's own worktree, between the arm and this
    // capture, so a `npm test` that reaches gate or repair appends rows to the
    // very log the capture reads. The old argument for reading the whole log —
    // a fresh worktree starts empty, so every row is this observation's — is
    // true about the WORKTREE and false about the measured SESSION.
    //
    // `scopeTelemetry` cannot rescue it, and this test proves that rather than
    // assuming it: the window admits any row within ±60,000 ms of the
    // session's requests whether or not the transcript names its
    // invocation_id, and acceptance rows are always seconds away.
    const ARM = "11111111-2222-4333-8444-555555555555";
    const ACC = "22222222-3333-4444-8555-666666666666";
    const armRow = { ts: "2026-08-07T10:00:01.000Z", tool: "gate", invocation_id: ARM, bytes_raw: 40 };
    const accRow = { ts: "2026-08-07T10:00:05.000Z", tool: "gate", invocation_id: ACC, bytes_raw: 999 };
    const { treeDir, slugDir } = await tree(
      { [TELEMETRY_REL_PATH]: jsonl(armRow) },
      {
        "own.jsonl": jsonl(
          line({
            sessionId: "s-own",
            requestId: "r-1",
            uuid: "u-1",
            message: {
              model: "claude-opus-5",
              usage: { input_tokens: 10 },
              content: [{ type: "tool_use", id: "tu-1", name: "mcp__local-coder__gate" }],
            },
          }),
          {
            type: "user",
            uuid: "u-2",
            sessionId: "s-own",
            timestamp: "2026-08-07T10:00:02.000Z",
            message: { content: [{ type: "tool_result", tool_use_id: "tu-1" }] },
            toolUseResult: { invocation_id: ARM, tool: "mcp__local-coder__gate" },
          }
        ),
      }
    );

    // The boundary the harness takes the moment BEFORE acceptance…
    const telemetryBytesAtAcceptance = (await fs.stat(path.join(treeDir, TELEMETRY_REL_PATH))).size;
    // …and then acceptance runs the tool under measurement.
    await fs.appendFile(path.join(treeDir, TELEMETRY_REL_PATH), JSON.stringify(accRow) + "\n", "utf8");

    const archive = await captureObservation({
      taskId: "t-01",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
      telemetryBytesAtAcceptance,
    });

    // The substantive claim FIRST, so a regression names the defect and not
    // the bookkeeping field beside it.
    expect(archive.telemetry.map((r) => r.invocation_id)).toEqual([ARM]);
    // Kept, not deleted — acceptance running the measured tool is a fact.
    expect(archive.telemetryAfterAcceptance.map((r) => r.invocation_id)).toEqual([ACC]);
    expect(archive.telemetryBoundaryBytes).toBe(telemetryBytesAtAcceptance);

    // THE DAMAGE, AT THE SCORER. Over the unsplit log the window admits the
    // acceptance row — 4 seconds from the session's only request, and its id
    // is nowhere in the transcript. Over the archived arm rows it cannot.
    const transcript = await readTranscript(path.join(slugDir, "own.jsonl"));
    const unsplit = await readTelemetry(treeDir);
    expect(scopeTelemetry(transcript, unsplit).map((r) => r.invocation_id)).toEqual([ARM, ACC]);
    expect(scopeTelemetry(transcript, archive.telemetry).map((r) => r.invocation_id)).toEqual([ARM]);
  });

  it("without a boundary the whole log is the arm's — the pre-R33 reading, said out loud", async () => {
    // `telemetryBytesAtAcceptance` omitted means NO SPLIT, not an empty arm.
    // A caller with no acceptance command must keep every row it captured.
    const rows = jsonl(
      { ts: "2026-08-07T10:00:01.000Z", tool: "gate", bytes_raw: 1 },
      { ts: "2026-08-07T10:00:02.000Z", tool: "repair", bytes_raw: 2 }
    );
    const { treeDir, slugDir } = await tree({ [TELEMETRY_REL_PATH]: rows }, { "own.jsonl": jsonl(line({ sessionId: "s-own" })) });
    const archive = await captureObservation({
      taskId: "t-01",
      arm: "control",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });
    expect(archive.telemetryBoundaryBytes).toBeNull();
    expect(archive.telemetry).toHaveLength(2);
    expect(archive.telemetryAfterAcceptance).toEqual([]);
  });

  it("a boundary landing MID-LINE gives the partial row to the arm, not to acceptance", async () => {
    // The stat can fall between an append's open and its bytes. Splitting the
    // row there would destroy it on both sides; a row being written when
    // acceptance starts was started by the arm.
    const armRow = { ts: "2026-08-07T10:00:01.000Z", tool: "gate", bytes_raw: 40 };
    const accRow = { ts: "2026-08-07T10:00:05.000Z", tool: "repair", bytes_raw: 999 };
    const text = jsonl(armRow, accRow);
    const { treeDir, slugDir } = await tree({ [TELEMETRY_REL_PATH]: text }, { "own.jsonl": jsonl(line({ sessionId: "s-own" })) });
    const archive = await captureObservation({
      taskId: "t-01",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
      // Ten bytes into the arm's own line.
      telemetryBytesAtAcceptance: 10,
    });
    expect(archive.telemetry.map((r) => r.tool)).toEqual(["gate"]);
    expect(archive.telemetryAfterAcceptance.map((r) => r.tool)).toEqual(["repair"]);
  });

  it("THE ARCHIVED telemetry.jsonl ROUND-TRIPS THROUGH readTelemetry IN ORDER", async () => {
    // UNIT 5 keys a row `[source, ordinal]` where the source is THIS file and the
    // ordinal is its position in the array `readTelemetry` returns. So the
    // written file has to reread as the same array in the same order, or every
    // key is a key to a different row — and nothing else in this suite checks
    // the format the harness writes, only the value it captured.
    const rows = [
      { ts: "2026-08-07T10:00:01.000Z", tool: "gate", invocation_id: "aaaaaaaa-1111-4111-8111-111111111111", bytes_raw: 40 },
      { ts: "2026-08-07T10:00:00.000Z", tool: "repair", bytes_raw: 7 },
      { ts: "2026-08-07T10:00:02.000Z", tool: "gate", bytes_raw: 0, detail: { nested: [1, { a: null }] } },
    ];
    const { treeDir, slugDir } = await tree(
      { [TELEMETRY_REL_PATH]: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });

    // Exactly what `scripts/b12-run.mjs` writes into the observation directory.
    const archiveRoot = tmp();
    await fs.mkdir(path.join(archiveRoot, ".local-coder"), { recursive: true });
    await fs.writeFile(
      path.join(archiveRoot, TELEMETRY_REL_PATH),
      archive.telemetry.map((r) => JSON.stringify(r)).join("\n") + (archive.telemetry.length > 0 ? "\n" : ""),
      "utf8"
    );

    const reread = await readTelemetry(archiveRoot);
    expect(reread).toEqual(archive.telemetry);
    // NOT sorted by `ts` — the rows above are deliberately out of time order, so
    // a writer that helpfully sorted them would shift every ordinal after the
    // first while still round-tripping as a SET.
    expect(reread.map((r) => r.tool)).toEqual(["gate", "repair", "gate"]);
  });

  it("hashes the worktree bytes, and the hash is of the file rather than of a summary", async () => {
    const body = "export const a = 1;\n";
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": body },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "control",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });
    const entry = archive.sourceFiles.find((f) => f.path === "src/a.ts");
    expect(entry?.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    // Forward slashes on every platform, or the archive is unreadable off Windows.
    expect(archive.sourceFiles.every((f) => !f.path.includes("\\"))).toBe(true);
  });

  it("EXCLUDES .git — a worktree's git directory is not a source file", async () => {
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": "a\n", ".git/HEAD": "ref: refs/heads/main\n", ".git/objects/ab/cdef": "binary" },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });
    expect(archive.sourceFiles.some((f) => f.path.startsWith(".git/"))).toBe(false);
    expect(archive.sourceFiles.map((f) => f.path)).toContain("src/a.ts");
  });

  it("A MISSING TELEMETRY LOG IS AN EMPTY LOG, NOT A REFUSAL", async () => {
    // B12 measures "installed, not invoked": an arm that called no local tool is
    // a legitimate observation, and `readTelemetry` defines a missing file as an
    // empty log. Refusing here would mint a rule the frozen text does not have.
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": "a\n" },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "control",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
    });
    expect(archive.telemetryFound).toBe(false);
    expect(archive.telemetry).toEqual([]);
    expect(archive.telemetryPath).toBe(path.join(treeDir, TELEMETRY_REL_PATH));
  });

  it("carries the dirty flag when acceptance ran against uncommitted work", async () => {
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": "a\n" },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: " M src/a.ts\n",
    });
    // `endCommit` is `git rev-parse HEAD` and acceptance runs against the working
    // tree, so this is the flag that says the two may describe different states.
    expect(archive.dirtyAtCapture).toBe(true);
  });

  it("labels the declared file scope without enforcing it", async () => {
    const { treeDir, slugDir } = await tree(
      { "src/a.ts": "a\n", "src/b.ts": "b\n" },
      { "own.jsonl": jsonl(line({ sessionId: "s-own", requestId: "r-1" })) }
    );
    const archive = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugDir],
      porcelain: "",
      declaredFileScope: ["src/a.ts"],
    });
    expect(archive.declaredFileScope).toEqual(["src/a.ts"]);
    // The superset is hashed anyway: "every source file" fixes the moment, not
    // the range, and refusing on the extra would mint the range.
    expect(archive.sourceFiles.map((f) => f.path)).toContain("src/b.ts");
  });

  it("searches EVERY slug it is given, and a fork into a second one joins the lineage", async () => {
    const root = tmp();
    const treeDir = path.join(root, "worktree");
    await fs.mkdir(treeDir, { recursive: true });
    await fs.writeFile(path.join(treeDir, "a.ts"), "a\n", "utf8");
    const slugA = path.join(root, "projects", "slug-a");
    const slugB = path.join(root, "projects", "slug-b");
    await fs.mkdir(slugA, { recursive: true });
    await fs.mkdir(slugB, { recursive: true });
    await fs.writeFile(path.join(slugA, "own.jsonl"), jsonl(line({ sessionId: "s-own", requestId: "r-1" })), "utf8");
    // A worktree gets its own slug, so a continuation can land in another one.
    await fs.writeFile(
      path.join(slugB, "cont.jsonl"),
      jsonl(line({ sessionId: "s-cont", requestId: "r-1", uuid: "u-c" })),
      "utf8"
    );

    const bothSlugs = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugA, slugB],
      porcelain: "",
    });
    expect(bothSlugs.lineage.map((l) => l.sessionId).sort()).toEqual(["s-cont", "s-own"]);

    // Searching one slug finds one file and reports the narrower search, which is
    // what makes an under-scoped capture visible rather than merely wrong.
    const oneSlug = await captureObservation({
      taskId: "t",
      arm: "treatment",
      sessionId: "s-own",
      treeDir,
      slugDirs: [slugA],
      porcelain: "",
    });
    expect(oneSlug.lineage.map((l) => l.sessionId)).toEqual(["s-own"]);
    expect(oneSlug.slugsSearched).toEqual(["slug-a"]);
  });
});
