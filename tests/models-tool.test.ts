import { describe, expect, it } from "vitest";

import { runModels } from "../src/tools/models.js";
import {
  fakeRunner,
  lmsListBody,
  makeTempRoot,
  noLmsRunner,
  queuedFetch,
  testConfig,
  unreachableFetch,
} from "./helpers.js";

const GB = 1024 ** 3;

/** A runner giving deterministic memory (32 GB total, `freePct`% free) plus canned lms sizes. */
function memAndLmsRunner(freePct: number, sizes: Array<{ id: string; sizeBytes: number }>) {
  return fakeRunner({
    sysctl: () => `${32 * GB}\n`,
    memory_pressure: () => `System-wide memory free percentage: ${freePct}%\n`,
    lms: () => lmsListBody(sizes),
  });
}

describe("models tool", () => {
  it("joins catalog with availability, size and fit; recommends one model", async () => {
    const { fetchImpl } = queuedFetch([{ object: "list", data: [{ id: "test-solo-model" }] }]);
    const runner = memAndLmsRunner(50, [
      { id: "test-solo-model", sizeBytes: 18 * GB },
      { id: "test-ide-model", sizeBytes: 8 * GB },
    ]);
    const result = await runModels(testConfig(makeTempRoot()), { concurrent_models: 1 }, {
      fetchImpl,
      platform: "darwin",
      runner,
    });

    expect(result.endpoint_reachable).toBe(true);
    expect(result.lms_available).toBe(true);
    expect(result.memory?.total_gb).toBe(32);
    expect(result.memory?.free_gb).toBe(16);
    expect(result.memory?.usable_free_gb).toBeCloseTo(13.6, 1);

    const solo = result.models.find((m) => m.model === "test-solo-model");
    const ide = result.models.find((m) => m.model === "test-ide-model");
    expect(solo).toMatchObject({ available: true, size_gb: 18, fits: false });
    expect(ide).toMatchObject({ available: false, size_gb: 8, fits: true });

    expect(result.recommended.models).toEqual(["test-ide-model"]);
    expect(result.recommended.fits).toBe(true);
  });

  it("packs multiple models for concurrent agents when RAM allows", async () => {
    const { fetchImpl } = queuedFetch([{ object: "list", data: [] }]);
    const runner = memAndLmsRunner(90, [
      { id: "test-solo-model", sizeBytes: 12 * GB },
      { id: "test-ide-model", sizeBytes: 8 * GB },
    ]);
    const result = await runModels(testConfig(makeTempRoot()), { concurrent_models: 2 }, {
      fetchImpl,
      platform: "darwin",
      runner,
    });
    // ~28.8 GB free, ~24.5 usable → both (12 + 8 = 20) fit, largest first.
    expect(result.recommended.models).toEqual(["test-solo-model", "test-ide-model"]);
    expect(result.recommended.fits).toBe(true);
  });

  it("reports lms_available: false and no sizes when lms is missing — never throws", async () => {
    const { fetchImpl } = queuedFetch([{ object: "list", data: [{ id: "test-solo-model" }] }]);
    const result = await runModels(testConfig(makeTempRoot()), {}, {
      fetchImpl,
      platform: "linux",
      runner: noLmsRunner(),
    });
    expect(result.lms_available).toBe(false);
    expect(result.models.every((m) => m.size_gb === null && m.fits === null)).toBe(true);
    expect(result.recommended.models).toEqual([]);
    expect(result.recommended.reason).toContain("no model sizes");
  });

  it("reports the endpoint hint when LM Studio is unreachable — never throws", async () => {
    const result = await runModels(testConfig(makeTempRoot()), {}, {
      fetchImpl: unreachableFetch(),
      platform: "linux",
      runner: noLmsRunner(),
    });
    expect(result.endpoint_reachable).toBe(false);
    expect(result.hint).toBe("start LM Studio's server with `lms server start`");
    expect(result.models.every((m) => m.available === null)).toBe(true);
  });
});
