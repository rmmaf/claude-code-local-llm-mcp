#!/usr/bin/env node
/**
 * Cost meter — what a Claude Code session actually cost, and what the local
 * tools saved.
 *
 *   npm run cost-meter                       # newest session for this project
 *   npm run cost-meter -- --last 5           # the last five
 *   npm run cost-meter -- --all --json       # everything, machine-readable
 *
 * Installed as a binary too, so it works without a clone of this repo:
 *
 *   npx -y -p github:rmmaf/claude-code-local-llm-mcp local-coder-cost-meter
 *
 * Reads Claude Code's own transcripts, so it measures billed quantities rather
 * than estimating them. The one estimated figure (bytes suppressed → tokens)
 * is labeled as such wherever it appears.
 */
import os from "node:os";
import path from "node:path";

import { readTelemetry, TELEMETRY_REL_PATH } from "../telemetry.js";
import { loadRates, RATES_REL_PATH } from "./rates.js";
import {
  buildCounterfactual,
  buildSessionReport,
  entryCostOfSegment,
  invocationOwners,
  scopeTelemetry,
} from "./report.js";
import type { Transcript } from "./transcript.js";
import { listSessionIds, projectTranscriptDir, readTranscript, sessionFiles } from "./transcript.js";

// Built at runtime so no escape sequence has to survive a file round-trip.
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

interface Options {
  dir: string | null;
  files: string[];
  session: string | null;
  last: number;
  all: boolean;
  root: string;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dir: null, files: [], session: null, last: 1, all: false, root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--dir": options.dir = next(); break;
      case "--file": options.files.push(next()); break;
      case "--session": options.session = next(); break;
      case "--last": options.last = Number(next()); break;
      case "--all": options.all = true; break;
      case "--root": options.root = path.resolve(next()); break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: cost-meter [--dir <transcripts>] [--file <f>]... [--session <id>] [--last N|--all] [--root <project>] [--json]\n"
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.last) || options.last < 1) options.last = 1;
  return options;
}

const fmt = new Intl.NumberFormat("en-US");
const int = (n: number): string => fmt.format(Math.round(n));

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function kib(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function bar(value: number, max: number, width = 28): string {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  return "█".repeat(Math.max(value > 0 ? 1 : 0, filled));
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rates = await loadRates(options.root);

  // A SESSION, NOT A FILE. Since Claude Code 2.1.219 one session is the main
  // transcript plus every `.jsonl` under `<sessionId>/`, and reading only the
  // first showed roughly half the cache tokens of a multi-agent session.
  // `--file` still reads exactly what it is handed: it is an explicit override,
  // and an override that quietly widened would be its own defect.
  const units: Array<{ files: string[]; sessionId?: string }> = [];
  /**
   * Every session in the directory, not only the chosen ones. Ownership of a
   * telemetry row is a fact about the SET — an `invocation_id` present in two
   * sessions belongs to neither — and `--session X` alone cannot see that. So
   * the set is always enumerated, even for a single-session run.
   */
  let siblings: string[] = [];
  if (options.files.length > 0) {
    for (const one of options.files) units.push({ files: [path.resolve(one)] });
  } else {
    const dir = options.dir ?? projectTranscriptDir(options.root, os.homedir());
    const all = await listSessionIds(dir);
    siblings = all;
    const found = options.session !== null ? [options.session] : all;
    if (found.length === 0) {
      process.stderr.write(`no transcripts found in ${dir}` + String.fromCharCode(10));
      process.exit(1);
    }
    const chosen = options.session !== null || options.all ? found : found.slice(-options.last);
    // THE ID IS PASSED, NOT JUST USED TO FIND THE FILES. Discarding it let the
    // read anchor on whatever the first billable record happened to say, so
    // `--session X` could return a total attributed to Y -- with X's own
    // subagent records then excluded as foreign, silently, because only a count
    // changed and not the visibility.
    //
    // It also made the two sides of B20 identify a session by DIFFERENT RULES:
    // the oracle requires record.sessionId to equal the id it was given, the
    // meter took the first record's word for it. They agreed on the scored run
    // because filename and records match on all 11 files of this corpus --
    // agreement by coincidence, which is the thing B20 exists to exclude.
    for (const id of chosen) units.push({ files: await sessionFiles(dir, id), sessionId: id });
  }

  const telemetry = await readTelemetry(options.root);
  const payloads: unknown[] = [];

  // Read every session ONCE, chosen or not, and keep it. The chosen ones are
  // reported; the rest exist only to answer "does anyone else carry this
  // invocation id?". Reading them twice, or extracting ids by a second rule
  // written here, is precisely how the two sides of B20 drifted apart.
  const dir = options.dir ?? projectTranscriptDir(options.root, os.homedir());
  const read = new Map<string, Transcript>();
  for (const id of siblings) read.set(id, await readTranscript(await sessionFiles(dir, id), id));
  for (const unit of units) {
    if (unit.sessionId === undefined || !read.has(unit.sessionId)) {
      read.set(unit.sessionId ?? unit.files.join("|"), await readTranscript(unit.files, unit.sessionId));
    }
  }
  // `--file` hands us an explicit list and no set to compare against, so nothing
  // can be shown ambiguous and nothing is claimed to have been checked.
  const ambiguousIds = invocationOwners(read.values());

  for (const unit of units) {
    const transcript =
      read.get(unit.sessionId ?? unit.files.join("|")) ?? (await readTranscript(unit.files, unit.sessionId));
    const session = buildSessionReport(transcript, rates);
    // How many records the admission rule refused. A session with none admitted
    // and some refused is a MIS-READ, not an empty session, and the difference
    // has to survive into both output modes.
    const dropped = Object.values(transcript.excluded).reduce((n, v) => n + v, 0);
    if (session.requests === 0 && dropped === 0) continue;

    const scoped = scopeTelemetry(transcript, telemetry);
    const counterfactual = buildCounterfactual(transcript, scoped, rates, session, ambiguousIds);

    if (options.json) {
      // NOTHING BUT JSON GOES TO STDOUT HERE. The zero-request branch used to
      // write its human line unconditionally, so `--json` emitted ANSI prose and
      // then the array — unparseable, and `B20` requires these artifacts to be
      // machine-produced. It also `continue`d before pushing, so the session was
      // missing from the payload entirely: the same invisibility one layer out,
      // inside the evidence file.
      payloads.push({ session, counterfactual });
      continue;
    }

    if (session.requests === 0) {
      process.stdout.write(
        `
${BOLD}SESSION ${transcript.sessionId.slice(0, 8)}${RESET}  ` +
          `${DIM}${transcript.files.length} file(s)${RESET}
` +
          `  0 billed requests, and ${int(dropped)} record(s) excluded ` +
          `(${Object.entries(transcript.excluded)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")})
` +
          `  ${DIM}a session with traffic on disk and none admitted is a mis-read, not an empty session${RESET}
`
      );
      continue;
    }

    const { breakdown } = session;
    process.stdout.write(
      `\n${BOLD}SESSION ${session.sessionId.slice(0, 8)}${RESET}  ${session.models.join(", ")}\n` +
        `${DIM}${session.file}${RESET}\n` +
        `  ${int(session.requests)} billed requests ` +
        `(${int(session.mainThreadRequests)} main, ${int(session.sidechainRequests)} subagent) ` +
        `across ${session.segments} context segment(s)\n\n`
    );

    const rows = (
      [
        [
          "cache write",
          breakdown.tokens.cacheWrite1h + breakdown.tokens.cacheWrite5m,
          breakdown.units.cacheWrite,
          breakdown.share.cacheWrite,
        ],
        ["cache read", breakdown.tokens.cacheRead, breakdown.units.cacheRead, breakdown.share.cacheRead],
        ["output", breakdown.tokens.output, breakdown.units.output, breakdown.share.output],
        ["input", breakdown.tokens.input, breakdown.units.input, breakdown.share.input],
      ] as Array<[string, number, number, number]>
    ).sort((a, b) => b[3] - a[3]);

    process.stdout.write(
      `  ${pad("class", 13)}${padStart("tokens", 12)}${padStart("units", 14)}${padStart("share", 8)}\n`
    );
    for (const [name, tokens, units, share] of rows) {
      process.stdout.write(
        `  ${pad(name, 13)}${padStart(int(tokens), 12)}${padStart(int(units), 14)}${padStart(pct(share), 8)}\n`
      );
    }
    process.stdout.write(
      `  ${DIM}${"─".repeat(45)}${RESET}\n` +
        `  ${pad("total", 13)}${padStart("", 12)}${padStart(int(breakdown.units.total), 14)}\n` +
        `  ${DIM}units = input-equivalent tokens${RESET}\n`
    );

    if (breakdown.usd !== null) {
      process.stdout.write(`  ${BOLD}USD ${breakdown.usd.toFixed(2)}${RESET}\n`);
    } else {
      // Name the keys that are actually missing, not the model. A key can carry
      // a speed suffix, and pointing at the bare model would send the reader to
      // a line they have already filled in.
      const missing = breakdown.unpricedKeys.length > 0 ? breakdown.unpricedKeys : ["model"];
      process.stdout.write(
        `  ${DIM}USD not shown — set ${missing.map((k) => `models[${JSON.stringify(k)}].inputPerMTok`).join(", ")} ` +
          `in ${RATES_REL_PATH}${RESET}\n`
      );
    }

    // The punchline: what one token costs when it enters at the start of THIS
    // session, computed from this session's own length.
    //
    // Anchored on the LONGEST main segment, not the first request in the file.
    // A resumed session opens with a leftover one-request segment, and reading
    // that one made the whole line vanish behind `segmentSize > 1` — the number
    // carrying the entire cost argument, silently absent on every resumed
    // session. The segment size is printed so the figure cannot be read as
    // covering more of the session than it does.
    let firstMain: (typeof transcript.requests)[number] | undefined;
    for (const request of transcript.requests) {
      if (request.isSidechain || request.index !== 0) continue;
      if (firstMain === undefined || request.segmentSize > firstMain.segmentSize) firstMain = request;
    }
    // Summed per request rather than multiplied out: `/model` and `/fast` can
    // both be toggled mid-segment, and a single rate applied across the whole
    // span would price every re-read after the switch at the pre-switch rate.
    const anchor =
      firstMain === undefined
        ? null
        : entryCostOfSegment(
            transcript.requests.filter((r) => !r.isSidechain && r.segment === firstMain.segment),
            rates
          );
    if (anchor !== null && anchor.requests > 1) {
      const span = `that context ran ${anchor.requests} requests`;
      if (anchor.multiplier !== null && anchor.write !== null && anchor.reread !== null) {
        process.stdout.write(
          `\n  ${BOLD}a token entering at turn 0 of this session's longest context costs ` +
            `${anchor.multiplier.toFixed(1)}x the input rate${RESET}\n` +
            `  ${DIM}${anchor.write} (cache write, ${anchor.ttl}) + ${anchor.reread.toFixed(1)} ` +
            `summed over ${anchor.requests - 1} re-reads; ${span}${RESET}\n`
        );
      } else if (anchor.usdPerMTok !== null) {
        // No single input rate to be a multiple OF, so the ratio is withheld
        // rather than computed against an arbitrary one of the bases.
        process.stdout.write(
          `\n  ${BOLD}a token entering at turn 0 of this session's longest context costs ` +
            `USD ${anchor.usdPerMTok.toFixed(2)} per million${RESET}\n` +
            `  ${DIM}no "x the input rate" figure: ${anchor.keys.join(" + ")} are priced ` +
            `differently, so their multipliers have different bases and do not add; ${span}${RESET}\n`
        );
      } else {
        // Two claims, and only one of them is licensed at a time. Known prices
        // that already differ settle the ratio question — a further missing
        // price cannot make unequal prices equal. Known prices that do NOT
        // settle it leave the answer unknown, and unknown is not "different":
        // two unpriced keys may share a price exactly.
        const missing =
          `${anchor.unpricedKeys.join(", ")} ` +
          `${anchor.unpricedKeys.length === 1 ? "has" : "have"} no inputPerMTok in ${RATES_REL_PATH}`;
        const ratio =
          anchor.sharesOneInputRate === false
            ? `the priced ones already differ, so there is no single input rate to be a multiple of either`
            : `and with that unknown there is no way to tell whether these keys share one input rate`;
        process.stdout.write(
          `\n  ${DIM}entry cost not shown — this context spans ${anchor.keys.join(" + ")}; ` +
            `${missing}, so there is no dollar figure, and ${ratio}; ${span}${RESET}\n`
        );
      }
    }

    const growth = session.growth;
    if (growth.length > 1) {
      const max = Math.max(...growth.map((g) => g.cacheRead));
      const step = Math.max(1, Math.ceil(growth.length / 12));
      process.stdout.write(`\n  ${DIM}context growth — tokens re-read per request${RESET}\n`);
      for (let i = 0; i < growth.length; i += step) {
        const point = growth[i];
        if (point === undefined) continue;
        process.stdout.write(
          `    ${padStart(`t${point.index}`, 5)} ${pad(bar(point.cacheRead, max), 29)}` +
            `${padStart(int(point.cacheRead), 10)}\n`
        );
      }
    }

    const tools = Object.entries(session.toolResultBytes.byTool).sort((a, b) => b[1].bytes - a[1].bytes);
    if (tools.length > 0) {
      process.stdout.write(
        `\n  ${DIM}tool results entering context: ${kib(session.toolResultBytes.total)} ` +
          `over ${int(transcript.toolResults.length)} calls${RESET}\n`
      );
      for (const [name, stats] of tools.slice(0, 8)) {
        process.stdout.write(
          `    ${pad(name, 16)}${padStart(int(stats.calls), 5)} calls${padStart(kib(stats.bytes), 12)}\n`
        );
      }
    }

    // Anything withheld is as much a result as anything counted. Gating the whole
    // block on `byTool` hid the withheld rows in exactly the case where they were
    // the only thing to say — which is today's case, and which made a report that
    // claims to surface exclusions silently omit them.
    // `provenanceUnavailable` is deliberately NOT part of this predicate: it is a
    // fact about the transcript, true even with an empty telemetry log, and
    // including it made a session with zero rows announce that every row had been
    // withheld. Only rows that actually exist decide whether there is a report.
    const counted = counterfactual.byTool.length > 0;
    const withheldRows = counterfactual.excludedForeign + counterfactual.unverifiable;

    if (counted || withheldRows > 0) {
      process.stdout.write(`\n  ${BOLD}estimated savings from local tools${RESET}\n`);
      if (counted) {
        process.stdout.write(
          `    ${pad("tool", 12)}${padStart("calls", 6)}${padStart("suppressed", 12)}` +
            `${padStart("turns", 7)}${padStart("units saved", 14)}\n`
        );
        for (const saving of counterfactual.byTool) {
          process.stdout.write(
            `    ${pad(saving.tool, 12)}${padStart(int(saving.calls), 6)}` +
              `${padStart(kib(saving.bytesSuppressed), 12)}${padStart(int(saving.turnsCollapsed), 7)}` +
              `${padStart(int(saving.unitsTotal), 14)}\n`
          );
        }
      } else {
        process.stdout.write(
          `    ${DIM}nothing counted — every telemetry row in range was withheld${RESET}\n`
        );
      }
      // WITHHELD PRINTS AS A SENTENCE, NEVER AS A NUMBER. `G-stop` stops this
      // project below 15%, so a figure produced by the timestamp fallback would
      // be read as that decision. Same treatment as an unpriced session's USD.
      process.stdout.write(
        `    ${DIM}${"─".repeat(51)}${RESET}\n` +
          (counterfactual.savedFraction === null
            ? `    ${BOLD}saving WITHHELD — the exact join is unavailable${RESET}\n` +
              `    ${DIM}rows carry an invocation id but no result in this transcript echoes one, ` +
              `so only timestamps remain and those cannot tell two sessions apart${RESET}\n`
            : `    ${BOLD}${pct(counterfactual.savedFraction)} of what this session would have cost${RESET}\n` +
              `    ${DIM}suppression term is an estimate (charsPerToken=${rates.charsPerToken}); ` +
              `turn-collapse term is a floor${RESET}\n`)
      );
      if (counterfactual.ambiguous > 0) {
        process.stdout.write(
          `    ${DIM}${int(counterfactual.ambiguous)} row(s) whose invocation id appears in more ` +
            `than one session were NOT counted (~${int(counterfactual.ambiguousUnits)} units ` +
            `withheld): a resumed conversation carries the original record forward, so the call ` +
            `belongs to no single session${RESET}\n`
        );
      }
      if (counterfactual.excludedForeign > 0) {
        process.stdout.write(
          `    ${DIM}${int(counterfactual.excludedForeign)} telemetry row(s) belong to another ` +
            `session and were excluded${RESET}\n`
        );
      }
      if (counterfactual.unverifiable > 0) {
        process.stdout.write(
          `    ${DIM}${int(counterfactual.unverifiable)} row(s) had no invocation id and were ` +
            `NOT counted (~${int(counterfactual.unverifiableUnits)} units withheld): a tool that ` +
            `cannot point at the transcript entry it produced cannot show its output ever ` +
            `reached the context${RESET}\n`
        );
      }
    } else if (telemetry.length === 0) {
      process.stdout.write(
        `\n  ${DIM}no ${TELEMETRY_REL_PATH} yet — savings appear once the local tools run${RESET}\n`
      );
    } else {
      // Rows exist but none belong to this session. Saying nothing here would
      // read as "no telemetry", which is a different and wrong story.
      process.stdout.write(
        `\n  ${DIM}${int(telemetry.length)} telemetry row(s) on disk, none in this session's range${RESET}\n`
      );
    }

    // Printed regardless of whether any telemetry exists: a broken echo is a
    // property of the transcript, and an empty log must not swallow the warning.
    if (counterfactual.provenanceUnavailable) {
      process.stdout.write(
        `  ${BOLD}this session called gate/repair but no result carried an invocation id${RESET}\n` +
          `  ${DIM}the exact join is NOT working — any saving above fell back to timestamps ` +
          `and may include another session's rows${RESET}\n`
      );
    }

    if (session.skippedLines > 0) {
      process.stdout.write(`\n  ${DIM}${session.skippedLines} unparseable line(s) skipped${RESET}\n`);
    }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(payloads, null, 2)}\n`);
  else process.stdout.write("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
