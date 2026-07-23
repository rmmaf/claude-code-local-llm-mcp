import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getMemoryInfo, parseMemoryPressure, parseVmStat } from "../src/memory.js";
import { fakeRunner } from "./helpers.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const memoryPressureFixture = readFileSync(path.join(FIXTURES, "memory_pressure.txt"), "utf8");
const vmStatFixture = readFileSync(path.join(FIXTURES, "vm_stat.txt"), "utf8");

const GB = 1024 ** 3;

describe("memory parsers", () => {
  it("parses the free percentage from memory_pressure output", () => {
    expect(parseMemoryPressure(memoryPressureFixture)).toBe(61);
  });

  it("returns null when memory_pressure output lacks the line", () => {
    expect(parseMemoryPressure("some unrelated output\n")).toBeNull();
    expect(parseMemoryPressure("")).toBeNull();
  });

  it("computes free bytes from vm_stat as (free + inactive + speculative) x page size", () => {
    const expected = (301234 + 561835 + 30186) * 16384;
    expect(parseVmStat(vmStatFixture)).toBe(expected);
  });

  it("returns null when vm_stat output is missing fields or page size", () => {
    expect(parseVmStat("Pages free: 100.\n")).toBeNull();
    expect(
      parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\n")
    ).toBeNull();
  });
});

describe("getMemoryInfo", () => {
  const memsize36 = () => `${36 * GB}\n`;

  it("uses memory_pressure on macOS: 61% of 36 GB (~22 GB free)", async () => {
    const info = await getMemoryInfo(
      fakeRunner({ sysctl: memsize36, memory_pressure: () => memoryPressureFixture }),
      "darwin"
    );
    expect(info?.source).toBe("memory_pressure");
    expect(info?.totalBytes).toBe(36 * GB);
    expect(info?.freeBytes).toBeGreaterThan(21 * GB);
    expect(info?.freeBytes).toBeLessThan(23 * GB);
  });

  it("falls back to vm_stat when memory_pressure throws", async () => {
    const info = await getMemoryInfo(
      fakeRunner({
        sysctl: memsize36,
        memory_pressure: () => {
          throw new Error("boom");
        },
        vm_stat: () => vmStatFixture,
      }),
      "darwin"
    );
    expect(info?.source).toBe("vm_stat");
  });

  it("falls back to vm_stat when memory_pressure output is unparseable", async () => {
    const info = await getMemoryInfo(
      fakeRunner({ sysctl: memsize36, memory_pressure: () => "garbage\n", vm_stat: () => vmStatFixture }),
      "darwin"
    );
    expect(info?.source).toBe("vm_stat");
  });

  it("returns null on macOS when every probe fails", async () => {
    const info = await getMemoryInfo(
      fakeRunner({
        sysctl: () => {
          throw new Error("no sysctl");
        },
      }),
      "darwin"
    );
    expect(info).toBeNull();
  });

  it("uses Node os numbers off macOS without shelling out", async () => {
    const info = await getMemoryInfo(fakeRunner({}), "linux");
    expect(info?.source).toBe("os");
    expect(info?.totalBytes).toBeGreaterThan(0);
  });
});
