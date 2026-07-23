import os from "node:os";

import { type CommandRunner, defaultRunner } from "./exec.js";
import { log } from "./logger.js";

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
 * back to vm_stat. Returns null when any macOS step fails. Off macOS, reports
 * Node's os module numbers with source "os". Never throws.
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
      log.warn("memory: could not parse sysctl hw.memsize output");
      return null;
    }
    try {
      const pct = parseMemoryPressure(await run("memory_pressure", []));
      if (pct !== null) {
        return { totalBytes, freeBytes: (totalBytes * pct) / 100, source: "memory_pressure" };
      }
      log.warn("memory: memory_pressure output had no free-percentage line; trying vm_stat");
    } catch {
      log.warn("memory: memory_pressure failed to run; trying vm_stat");
    }
    const freeBytes = parseVmStat(await run("vm_stat", []));
    if (freeBytes === null) {
      log.warn("memory: vm_stat output could not be parsed");
      return null;
    }
    return { totalBytes, freeBytes, source: "vm_stat" };
  } catch (error) {
    log.warn(`memory: detection failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function bytesToGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}
