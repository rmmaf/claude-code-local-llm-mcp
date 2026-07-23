import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getLmsModels, parseLmsList, parseLmsPs } from "../src/lms.js";
import { fakeRunner } from "./helpers.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const lmsLsFixture = readFileSync(path.join(FIXTURES, "lms_ls.json"), "utf8");

describe("parseLmsList", () => {
  it("extracts id candidates and size from the fixture", () => {
    const models = parseLmsList(lmsLsFixture);
    expect(models.length).toBe(3);
    const big = models.find((m) => m.id.includes("Qwen3-Coder-30B"));
    expect(big?.sizeBytes).toBe(17179869184);
    expect(big?.ids).toContain("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2");
  });

  it("is defensive about field names (size/size_bytes, key/displayName)", () => {
    const json = JSON.stringify([
      { key: "a-model", size: 1000 },
      { displayName: "b-model", size_bytes: 2000 },
    ]);
    const models = parseLmsList(json);
    expect(models).toEqual([
      { id: "a-model", ids: ["a-model"], sizeBytes: 1000 },
      { id: "b-model", ids: ["b-model"], sizeBytes: 2000 },
    ]);
  });

  it("unwraps object payloads with a models/data array", () => {
    const json = JSON.stringify({ models: [{ path: "m", sizeBytes: 5 }] });
    expect(parseLmsList(json)).toEqual([{ id: "m", ids: ["m"], sizeBytes: 5 }]);
  });

  it("skips rows with no usable size and returns [] on non-JSON", () => {
    expect(parseLmsList(JSON.stringify([{ path: "no-size" }, { path: "ok", sizeBytes: 10 }]))).toEqual([
      { id: "ok", ids: ["ok"], sizeBytes: 10 },
    ]);
    expect(parseLmsList("not json at all")).toEqual([]);
    expect(parseLmsList(JSON.stringify({ nope: true }))).toEqual([]);
  });
});

describe("parseLmsPs", () => {
  it("extracts loaded model ids", () => {
    const json = JSON.stringify([{ modelKey: "loaded-a" }, { path: "loaded-b" }]);
    expect(parseLmsPs(json).map((m) => m.id)).toEqual(["loaded-a", "loaded-b"]);
  });
});

describe("getLmsModels", () => {
  it("returns parsed models from a runner", async () => {
    const models = await getLmsModels(fakeRunner({ lms: () => lmsLsFixture }));
    expect(models?.length).toBe(3);
  });

  it("returns null when the runner throws (e.g. lms not installed)", async () => {
    const models = await getLmsModels(async () => {
      throw new Error("spawn lms ENOENT");
    });
    expect(models).toBeNull();
  });

  it("returns [] (not null) on unrecognized but valid JSON", async () => {
    const models = await getLmsModels(fakeRunner({ lms: () => "{}" }));
    expect(models).toEqual([]);
  });
});
