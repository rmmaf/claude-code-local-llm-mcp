import { describe, expect, it } from "vitest";

import type { LmsModel } from "../src/lms.js";
import type { ModelEntry } from "../src/models-csv.js";
import {
  buildCatalogReport,
  matchModel,
  resolveModel,
  selectModelForMemory,
  selectModelsForMemory,
  usableFree,
} from "../src/selection.js";
import { fakeRunner, lmsListBody, testConfig } from "./helpers.js";

const GB = 1024 ** 3;

function entry(model: string): ModelEntry {
  return { model, objective: `objective for ${model}` };
}
function lms(model: string, gb: number): LmsModel {
  return { id: model, ids: [model], sizeBytes: gb * GB };
}
/** Build a catalog report from sizes (GB) and a usable-free budget (GB or null). */
function report(sizes: Array<[string, number]>, usableGb: number | null) {
  const catalog = sizes.map(([m]) => entry(m));
  const models = sizes.map(([m, gb]) => lms(m, gb));
  return buildCatalogReport(catalog, null, models, null, usableGb === null ? null : usableGb * GB);
}

describe("matchModel", () => {
  it("matches exactly (case-insensitively)", () => {
    expect(matchModel("Qwen2.5-Coder", ["qwen2.5-coder"])).toEqual({ value: "qwen2.5-coder", quality: "exact" });
  });

  it("matches on basename when a publisher prefix differs", () => {
    const r = matchModel("qwen2.5-coder-14b-instruct", ["lmstudio-community/qwen2.5-coder-14b-instruct"]);
    expect(r.value).toBe("lmstudio-community/qwen2.5-coder-14b-instruct");
    expect(r.quality).toBe("fuzzy");
  });

  it("matches after stripping quant/format suffixes", () => {
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct-mlx"]).quality).toBe("fuzzy");
    expect(
      matchModel("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2", [
        "Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
      ]).quality
    ).toBe("fuzzy");
  });

  it("does not collide different parameter sizes", () => {
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-32b-instruct"]).quality).toBe("none");
    expect(matchModel("qwen2.5-coder-14b", ["llama-3-8b"]).value).toBeNull();
  });
});

describe("usableFree", () => {
  it("applies the fit fraction to free bytes, or null when memory is unknown", () => {
    expect(usableFree({ totalBytes: 200, freeBytes: 100, source: "os" }, 0.85)).toBe(85);
    expect(usableFree(null, 0.85)).toBeNull();
  });
});

describe("buildCatalogReport", () => {
  it("joins availability, size and fit per model, preserving catalog order", () => {
    const r = buildCatalogReport(
      [entry("a"), entry("b")],
      ["a"],
      [lms("a", 10), lms("b", 100)],
      null,
      50 * GB
    );
    expect(r.map((x) => x.model)).toEqual(["a", "b"]);
    expect(r[0]).toMatchObject({ available: true, sizeGb: 10, fits: true, loaded: null });
    expect(r[1]).toMatchObject({ available: false, sizeGb: 100, fits: false });
  });

  it("reports null availability/size/fit when the surfaces are unavailable", () => {
    const r = buildCatalogReport([entry("a")], null, null, null, null);
    expect(r[0]).toMatchObject({ available: null, sizeBytes: null, fits: null });
  });
});

describe("selectModelForMemory", () => {
  it("picks the largest model that fits usable free RAM", () => {
    const r = report([["small", 10], ["big", 20]], 50);
    expect(selectModelForMemory(r, [entry("small"), entry("big")]).model).toBe("big");
  });

  it("breaks ties by catalog order", () => {
    const r = report([["first", 10], ["second", 10]], 50);
    expect(selectModelForMemory(r, [entry("first"), entry("second")]).model).toBe("first");
  });

  it("falls back to the first catalog entry when nothing fits", () => {
    const r = report([["a", 100], ["b", 200]], 50);
    const sel = selectModelForMemory(r, [entry("a"), entry("b")]);
    expect(sel.model).toBe("a");
    expect(sel.reason).toContain("no catalog model fit");
  });

  it("falls back to the first catalog entry when sizes are unknown", () => {
    const r = buildCatalogReport([entry("a"), entry("b")], null, null, null, 50 * GB);
    const sel = selectModelForMemory(r, [entry("a"), entry("b")]);
    expect(sel.model).toBe("a");
    expect(sel.reason).toContain("no model sizes");
  });
});

describe("selectModelsForMemory", () => {
  it("packs up to N models largest-first within usable free RAM", () => {
    const r = report([["a", 10], ["b", 20]], 50);
    const sel = selectModelsForMemory(r, 50 * GB, 2);
    expect(sel.models).toEqual(["b", "a"]);
    expect(sel.fits).toBe(true);
    expect(sel.totalGb).toBe(30);
  });

  it("reports fits:false when only some of N requested models fit", () => {
    const r = report([["a", 10], ["b", 20]], 25);
    const sel = selectModelsForMemory(r, 25 * GB, 2);
    expect(sel.models).toEqual(["b"]);
    expect(sel.fits).toBe(false);
  });

  it("returns no models when sizes are unknown", () => {
    const r = buildCatalogReport([entry("a")], null, null, null, 50 * GB);
    const sel = selectModelsForMemory(r, 50 * GB, 1);
    expect(sel.models).toEqual([]);
    expect(sel.reason).toContain("no model sizes");
  });
});

describe("resolveModel", () => {
  it("returns an explicit model verbatim (flagging when it's not in the catalog)", async () => {
    const config = testConfig("/tmp");
    expect((await resolveModel("test-solo-model", config)).reason).toContain("explicit model requested: test-solo-model");
    const off = await resolveModel("not-in-catalog", config);
    expect(off.model).toBe("not-in-catalog");
    expect(off.reason).toContain("not in catalog");
  });

  it("auto-picks the largest model that fits when no model is given", async () => {
    const config = testConfig("/tmp");
    const runner = fakeRunner({
      sysctl: () => `${32 * GB}\n`,
      memory_pressure: () => "System-wide memory free percentage: 50%\n", // ~16 GB free, ~13.6 usable
      lms: () => lmsListBody([
        { id: "test-solo-model", sizeBytes: 18 * GB },
        { id: "test-ide-model", sizeBytes: 8 * GB },
      ]),
    });
    const sel = await resolveModel(undefined, config, { platform: "darwin", runner });
    expect(sel.model).toBe("test-ide-model"); // 18 GB doesn't fit 13.6, 8 GB does
  });

  it("auto-picks the largest fitting model when RAM is ample", async () => {
    const config = testConfig("/tmp");
    const runner = fakeRunner({
      sysctl: () => `${64 * GB}\n`,
      memory_pressure: () => "System-wide memory free percentage: 90%\n", // ~57.6 GB free
      lms: () => lmsListBody([
        { id: "test-solo-model", sizeBytes: 18 * GB },
        { id: "test-ide-model", sizeBytes: 8 * GB },
      ]),
    });
    const sel = await resolveModel(undefined, config, { platform: "darwin", runner });
    expect(sel.model).toBe("test-solo-model");
  });
});
