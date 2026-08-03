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
import { buildCounterfactual, buildSessionReport, entryCostOfSegment, scopeTelemetry } from "./report.js";
import { listTranscripts, projectTranscriptDir, readTranscript } from "./transcript.js";

// Built at runtime so no escape sequence has to survive a file round-trip.
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

interface Options {
  dir: string | null;
  files: string[];
  last: number;
  all: boolean;
  root: string;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dir: null, files: [], last: 1, all: false, root: process.cwd(), json: false };
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
      case "--last": options.last = Number(next()); break;
      case "--all": options.all = true; break;
      case "--root": options.root = path.resolve(next()); break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: cost-meter [--dir <transcripts>] [--file <f>]... [--last N|--all] [--root <project>] [--json]\n"
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

  let files = options.files.map((f) => path.resolve(f));
  if (files.length === 0) {
    const dir = options.dir ?? projectTranscriptDir(options.root, os.homedir());
    const found = await listTranscripts(dir);
    if (found.length === 0) {
      process.stderr.write(`no transcripts found in ${dir}\n`);
      process.exit(1);
    }
    files = options.all ? found : found.slice(-options.last);
  }

  const telemetry = await readTelemetry(options.root);
  const payloads: unknown[] = [];

  for (const file of files) {
    const transcript = await readTranscript(file);
    const session = buildSessionReport(transcript, rates);
    if (session.requests === 0) continue;

    const scoped = scopeTelemetry(transcript, telemetry);
    const counterfactual = buildCounterfactual(transcript, scoped, rates, session);

    if (options.json) {
      payloads.push({ session, counterfactual });
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
        // NOT "priced differently" — with a price missing, these keys cannot be
        // compared at all, and two unpriced keys may well share a price. Saying
        // they differ would assert a fact the rates file does not contain.
        process.stdout.write(
          `\n  ${DIM}entry cost not shown — this context spans ${anchor.keys.join(" + ")} and ` +
            `${anchor.unpricedKeys.join(", ")} ${anchor.unpricedKeys.length === 1 ? "has" : "have"} ` +
            `no inputPerMTok in ${RATES_REL_PATH}, so there is no dollar figure and no way to tell ` +
            `whether these keys share one input rate to be a multiple of; ${span}${RESET}\n`
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
      process.stdout.write(
        `    ${DIM}${"─".repeat(51)}${RESET}\n` +
          `    ${BOLD}${pct(counterfactual.savedFraction)} of what this session would have cost${RESET}\n` +
          `    ${DIM}suppression term is an estimate (charsPerToken=${rates.charsPerToken}); ` +
          `turn-collapse term is a floor${RESET}\n`
      );
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
