import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import type { Config } from "./config.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

export type Profile = "solo" | "ide";

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
  return stdout;
};

/**
 * Parse `memory_pressure` output. Returns the system-wide free percentage
 * (0–100) or null when the expected line is absent.
 */
export function parseMemoryPressure(output: string): number | null {
  const match = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)\s*%/);
  if (!match || match[1] === undefined) return null;
  const pct = Number(match[1]);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

/**
 * Parse `vm_stat` output. Returns free bytes computed as
 * (free + inactive + speculative) pages × page size, or null on any miss.
 */
export function parseVmStat(output: string): number | null {
  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/);
  if (!pageSizeMatch || pageSizeMatch[1] === undefined) return null;
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  let pages = 0;
  for (const field of ["Pages free", "Pages inactive", "Pages speculative"]) {
    const match = output.match(new RegExp(`${field}:\\s+(\\d+)`));
    if (!match || match[1] === undefined) return null;
    pages += Number(match[1]);
  }
  return pages * pageSize;
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  /** Which probe produced freeBytes: memory_pressure | vm_stat | os */
  source: string;
}

/**
 * Measure total and free RAM on macOS via sysctl + memory_pressure, falling
 * back to vm_stat. Returns null when any step fails (caller falls back to
 * `solo`). Off macOS, reports Node's os module numbers with source "os".
 */
export async function getMemoryInfo(
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform
): Promise<MemoryInfo | null> {
  if (platform !== "darwin") {
    return { totalBytes: os.totalmem(), freeBytes: os.freemem(), source: "os" };
  }
  try {
    const totalBytes = Number((await run("sysctl", ["-n", "hw.memsize"])).trim());
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      log.warn("profile: could not parse sysctl hw.memsize output");
      return null;
    }
    try {
      const pct = parseMemoryPressure(await run("memory_pressure", []));
      if (pct !== null) {
        return { totalBytes, freeBytes: (totalBytes * pct) / 100, source: "memory_pressure" };
      }
      log.warn("profile: memory_pressure output had no free-percentage line; trying vm_stat");
    } catch {
      log.warn("profile: memory_pressure failed to run; trying vm_stat");
    }
    const freeBytes = parseVmStat(await run("vm_stat", []));
    if (freeBytes === null) {
      log.warn("profile: vm_stat output could not be parsed");
      return null;
    }
    return { totalBytes, freeBytes, source: "vm_stat" };
  } catch (error) {
    log.warn(`profile: memory detection failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function decideProfile(freeGb: number, thresholdGb: number): Profile {
  return freeGb >= thresholdGb ? "solo" : "ide";
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

export interface ProfileSelection {
  profile: Profile;
  reason: string;
  memory: MemoryInfo | null;
}

/**
 * Auto-select the profile when the tool argument is omitted. macOS: free GB ≥
 * threshold → solo, else ide. Non-macOS or detection failure → solo, per spec.
 * The decision and the numbers are always logged to stderr.
 */
export async function autoSelectProfile(
  config: Config,
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform
): Promise<ProfileSelection> {
  if (platform !== "darwin") {
    const selection: ProfileSelection = {
      profile: "solo",
      reason: `non-macOS platform (${platform}); defaulting to solo`,
      memory: await getMemoryInfo(run, platform),
    };
    log.info(`profile auto-selection: solo (${selection.reason})`);
    return selection;
  }

  const memory = await getMemoryInfo(run, platform);
  if (memory === null) {
    log.info("profile auto-selection: solo (memory detection failed; defaulting to solo)");
    return { profile: "solo", reason: "memory detection failed; defaulting to solo", memory: null };
  }

  const freeGb = bytesToGb(memory.freeBytes);
  const totalGb = bytesToGb(memory.totalBytes);
  const profile = decideProfile(freeGb, config.soloMinFreeGb);
  const reason =
    `free ${freeGb} GB of ${totalGb} GB (via ${memory.source}) ` +
    `${profile === "solo" ? "≥" : "<"} threshold ${config.soloMinFreeGb} GB`;
  log.info(`profile auto-selection: ${profile} (${reason})`);
  return { profile, reason, memory };
}
