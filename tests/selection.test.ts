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

  it("strips quant suffixes spelled with LM Studio's \"@\" separator", () => {
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct@8bit"]).quality).toBe("fuzzy");
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct@4bit"]).quality).toBe("fuzzy");
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct@q4_k_m"]).quality).toBe("fuzzy");
    // A mixed "-" then "@" run, which is what `lms ls` actually prints.
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct-mlx@8bit"]).quality).toBe("fuzzy");
    // Publisher prefix and "@" quant at once: basename split, then strip.
    expect(
      matchModel("qwen2.5-coder-14b-instruct", ["lmstudio-community/qwen2.5-coder-14b-instruct-mlx@8bit"]).quality
    ).toBe("fuzzy");
    // And the other direction: the catalog carries the quant, the candidate doesn't.
    expect(matchModel("qwen2.5-coder-14b-instruct@8bit", ["qwen2.5-coder-14b-instruct"]).quality).toBe("fuzzy");
  });

  it("returns the candidate id verbatim, quant suffix included", () => {
    // Stripping is for comparison only. The id that comes back is what gets
    // sent to LM Studio, so dropping the quant here would silently load a
    // different quantization than the one on disk.
    const r = matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct-mlx@8bit"]);
    expect(r.value).toBe("qwen2.5-coder-14b-instruct-mlx@8bit");
  });

  it("still prefers an exact match over a stripped one", () => {
    const r = matchModel("qwen2.5-coder-14b-instruct@8bit", [
      "qwen2.5-coder-14b-instruct",
      "qwen2.5-coder-14b-instruct@8bit",
    ]);
    expect(r).toEqual({ value: "qwen2.5-coder-14b-instruct@8bit", quality: "exact" });
  });

  it("does not collide different parameter sizes", () => {
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-32b-instruct"]).quality).toBe("none");
    expect(matchModel("qwen2.5-coder-14b", ["llama-3-8b"]).value).toBeNull();
  });

  it("sends the id LM Studio serves, not the one the catalog wrote down", () => {
    // The whole point of matching a quant spelling: an entry reported available
    // on a fuzzy match has to be REQUESTED under the id that matched. Sending
    // the catalog id asks for a model the endpoint does not have, and the
    // failure surfaces at generation time as a missing model rather than here.
    const catalog = [{ model: "qwen2.5-coder-14b-instruct", objective: "x" }];
    const served = ["qwen2.5-coder-14b-instruct-mlx@8bit"];
    const lms = [
      { id: served[0]!, ids: [served[0]!], sizeBytes: 15_000_000_000, quantization: null, path: null },
    ];
    const report = buildCatalogReport(catalog, served, lms, null, 30_000_000_000);
    expect(report[0]!.available).toBe(true);
    expect(report[0]!.model).toBe("qwen2.5-coder-14b-instruct");
    expect(report[0]!.resolvedId).toBe(served[0]);
    expect(selectModelForMemory(report, catalog).model).toBe(served[0]);
  });

  it("keeps the catalog id when /models was never consulted", () => {
    const catalog = [{ model: "qwen2.5-coder-14b-instruct", objective: "x" }];
    const report = buildCatalogReport(catalog, null, null, null, null);
    expect(report[0]!.available).toBeNull();
    expect(report[0]!.resolvedId).toBe("qwen2.5-coder-14b-instruct");
  });

  it("resolves the id on the no-sizes fallback path too", () => {
    // Sizes unknown says nothing about which spelling the endpoint answers to.
    const catalog = [{ model: "qwen2.5-coder-14b-instruct", objective: "x" }];
    const served = ["qwen2.5-coder-14b-instruct-mlx@8bit"];
    const report = buildCatalogReport(catalog, served, null, null, null);
    const sel = selectModelForMemory(report, catalog);
    expect(sel.model).toBe(served[0]);
    expect(sel.reason).toContain("served as");
  });

  it("does not let \"@\" stripping blur models apart", () => {
    // Quant distinguishes one base model; a different parameter count is a
    // different model, on either side of the separator.
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-32b-instruct@8bit"]).quality).toBe("none");
    expect(matchModel("qwen2.5-coder-14b-instruct@8bit", ["qwen2.5-coder-32b-instruct@q4_k_m"]).quality).toBe("none");
    // Only a *known quant token* comes off, not whatever follows an "@" — the
    // guard against this degrading into a plain split on "@".
    expect(matchModel("qwen2.5-coder-14b-instruct", ["qwen2.5-coder-14b-instruct@turbo"]).quality).toBe("none");
    // An "@" mid-id is not a trailing suffix and survives, even when a real
    // quant suffix is stripped from the same id.
    expect(matchModel("qwen2.5@8bit-coder-14b-instruct", ["qwen2.5-coder-14b-instruct"]).quality).toBe("none");
    expect(matchModel("qwen2.5@8bit-coder-14b-instruct-mlx", ["qwen2.5-coder-14b-instruct"]).quality).toBe("none");
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
