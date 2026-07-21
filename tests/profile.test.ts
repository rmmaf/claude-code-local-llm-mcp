import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  autoSelectProfile,
  decideProfile,
  parseMemoryPressure,
  parseVmStat,
  type CommandRunner,
} from "../src/profile.js";
import { testConfig } from "./helpers.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const memoryPressureFixture = readFileSync(path.join(FIXTURES, "memory_pressure.txt"), "utf8");
const vmStatFixture = readFileSync(path.join(FIXTURES, "vm_stat.txt"), "utf8");

const GB = 1024 ** 3;

function runner(handlers: Record<string, () => string>): CommandRunner {
  return async (command) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command: ${command}`);
    return handler();
  };
}

describe("parsers", () => {
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

describe("threshold logic", () => {
  it("selects solo at or above the threshold, ide below it", () => {
    expect(decideProfile(20, 20)).toBe("solo");
    expect(decideProfile(20.1, 20)).toBe("solo");
    expect(decideProfile(19.9, 20)).toBe("ide");
    expect(decideProfile(0, 20)).toBe("ide");
  });
});

describe("autoSelectProfile", () => {
  const config = testConfig("/tmp");
  const memsize36 = () => `${36 * GB}\n`;

  it("uses memory_pressure on macOS: 61% of 36 GB (~22 GB free) -> solo", async () => {
    const selection = await autoSelectProfile(
      config,
      runner({ sysctl: memsize36, memory_pressure: () => memoryPressureFixture }),
      "darwin"
    );
    expect(selection.profile).toBe("solo");
    expect(selection.memory?.source).toBe("memory_pressure");
  });

  it("picks ide when free memory is below the threshold", async () => {
    const lowFree = memoryPressureFixture.replace("61%", "30%"); // ~10.8 GB free
    const selection = await autoSelectProfile(
      config,
      runner({ sysctl: memsize36, memory_pressure: () => lowFree }),
      "darwin"
    );
    expect(selection.profile).toBe("ide");
  });

  it("falls back to vm_stat when memory_pressure fails", async () => {
    const selection = await autoSelectProfile(
      config,
      runner({
        sysctl: memsize36,
        memory_pressure: () => {
          throw new Error("boom");
        },
        vm_stat: () => vmStatFixture,
      }),
      "darwin"
    );
    // (301234 + 561835 + 30186) * 16384 bytes ≈ 13.6 GB < 20 GB -> ide
    expect(selection.profile).toBe("ide");
    expect(selection.memory?.source).toBe("vm_stat");
  });

  it("falls back to vm_stat when memory_pressure output is unparseable", async () => {
    const selection = await autoSelectProfile(
      config,
      runner({
        sysctl: memsize36,
        memory_pressure: () => "garbage output\n",
        vm_stat: () => vmStatFixture,
      }),
      "darwin"
    );
    expect(selection.memory?.source).toBe("vm_stat");
  });

  it("defaults to solo when every probe fails", async () => {
    const selection = await autoSelectProfile(
      config,
      runner({
        sysctl: () => {
          throw new Error("no sysctl");
        },
      }),
      "darwin"
    );
    expect(selection.profile).toBe("solo");
    expect(selection.memory).toBeNull();
  });

  it("defaults to solo on non-macOS without shelling out", async () => {
    const selection = await autoSelectProfile(
      config,
      runner({}), // any exec would throw "unexpected command"
      "linux"
    );
    expect(selection.profile).toBe("solo");
    expect(selection.reason).toContain("non-macOS");
  });
});
