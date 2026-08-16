/**
 * THE INSTRUMENT BEHIND THE `stdio.test.ts` SECTION OF PREMISES.md.
 *
 *   node scripts/stdio-chunking-probe.mjs [runs]        # default 20
 *
 * Committed because an unreproducible figure is not a measurement. Every number in that
 * section — partial tails, chunks per run, bytes per run, largest chunk, non-ASCII bytes —
 * comes out of this file, and a reader who doubts one can regenerate it.
 *
 * IT MEASURES TWO THINGS AND DIAGNOSES NEITHER:
 *
 *  1. Does a stdout chunk boundary ever land MID-MESSAGE, so that the pre-2026-08-14
 *     handler — which ran `JSON.parse` over every line including a possibly-partial last
 *     one — would throw inside a `data` handler? The pre-registered falsifiable form was:
 *     "> 0 in at least one of N runs, or THE MECHANISM IS NOT ESTABLISHED."
 *
 *  2. How many non-ASCII bytes the server puts on stdout. This is the SAME boundary
 *     question asked of characters instead of lines: a boundary inside a multi-byte
 *     sequence under a per-chunk `chunk.toString("utf8")` decodes to U+FFFD on both
 *     sides, and the damaged JSON STILL PARSES — silent corruption where the partial-line
 *     path at least threw.
 *
 * Deliberately NOT under vitest: both questions are properties of the pipe and the writer,
 * and a test runner would add a variable neither prediction named. That is a REAL limit of
 * this instrument, not a footnote — chunking under vitest is untested by it.
 *
 * Requires `dist/server.js`. Run `npm run build` first: `npx vitest run` skips the build
 * that `npm test` performs, and a stale `dist/` has already made this suite lie once
 * (PREMISES.md, the five-vs-seven-tools entry).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server.js");
const RUNS = Number(process.argv[2] ?? "20");

if (!existsSync(SERVER)) {
  console.error(`${SERVER} does not exist — run \`npm run build\` first`);
  process.exit(2);
}

/** The EXACT expression the handler used before 2026-08-14. Copied, not paraphrased. */
function legacyParse(stdoutRaw) {
  return stdoutRaw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function once() {
  return new Promise((resolve) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "stdio-chunking-probe-"));
    const child = spawn(process.execPath, [SERVER], {
      cwd: root,
      // A port that is definitely closed, so the status call stays offline-safe.
      env: { ...process.env, LM_STUDIO_URL: "http://127.0.0.1:1/v1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks = [];
    let stdoutRaw = "";
    const obs = {
      chunks: 0,
      chunkSizes: [],
      partialTails: 0,
      legacyThrows: 0,
      totalBytes: 0,
      nonAsciiBytes: 0,
      timedOut: false,
      spawnError: null,
    };

    child.on("error", (e) => {
      obs.spawnError = String(e && e.message);
    });
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      obs.chunks += 1;
      obs.chunkSizes.push(chunk.length);
      stdoutRaw += chunk.toString("utf8");
      if (stdoutRaw.length > 0 && !stdoutRaw.endsWith("\n")) obs.partialTails += 1;
      try {
        legacyParse(stdoutRaw);
      } catch {
        obs.legacyThrows += 1;
      }
    });
    child.stderr.on("data", () => {});

    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

    // Tolerant per-line id check. It does NOT use `legacyParse`, so a partial tail cannot
    // stall the driver and suppress the very count this exists to take. It cannot turn
    // "at least one partial tail" into zero — it only stops one from ending the run.
    const sawId = (id) =>
      stdoutRaw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .some((l) => {
          try {
            return JSON.parse(l).id === id;
          } catch {
            return false;
          }
        });

    const waitFor = (pred, ms = 10_000) =>
      new Promise((res) => {
        const started = Date.now();
        const t = setInterval(() => {
          if (pred()) {
            clearInterval(t);
            res();
          } else if (Date.now() - started > ms) {
            clearInterval(t);
            obs.timedOut = true;
            res();
          }
        }, 25);
      });

    (async () => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-chunking-probe", version: "0.0.0" },
        },
      });
      await waitFor(() => sawId(1));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await waitFor(() => sawId(2));
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
      await waitFor(() => sawId(3));

      const all = Buffer.concat(chunks);
      obs.totalBytes = all.length;
      for (const b of all) if (b >= 0x80) obs.nonAsciiBytes += 1;
      child.kill();
      child.once("exit", () => resolve(obs));
      setTimeout(() => resolve(obs), 2_000).unref();
    })();
  });
}

const runs = [];
for (let i = 0; i < RUNS; i += 1) runs.push(await once());

const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
console.log(
  JSON.stringify(
    {
      runs: RUNS,
      node: process.version,
      platform: process.platform,
      runsWithAnyPartialTail: runs.filter((r) => r.partialTails > 0).length,
      runsWhereLegacyParseWouldThrow: runs.filter((r) => r.legacyThrows > 0).length,
      totalPartialTails: sum((r) => r.partialTails),
      chunksPerRun: runs.map((r) => r.chunks),
      totalBytesPerRun: runs.map((r) => r.totalBytes),
      largestChunkBytes: Math.max(...runs.flatMap((r) => r.chunkSizes)),
      nonAsciiBytesPerRun: runs.map((r) => r.nonAsciiBytes),
      timedOut: runs.filter((r) => r.timedOut).length,
      spawnErrors: runs.filter((r) => r.spawnError !== null).length,
    },
    null,
    2
  )
);
