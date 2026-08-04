import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getLmsModels, parseLmsList, parseLmsPs, pickLoadedContextTokens } from "../src/lms.js";
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

  /**
   * The loaded context length is what actually bounds a whole-file answer, since
   * input and output share it — see the LmsLoadedModel doc comment.
   */
  it("extracts the loaded and maximum context lengths", () => {
    const json = JSON.stringify([
      { modelKey: "a", contextLength: 16384, maxContextLength: 262144 },
    ]);
    const [row] = parseLmsPs(json);
    expect(row?.contextLength).toBe(16384);
    expect(row?.maxContextLength).toBe(262144);
  });

  it("reports a missing or unusable context length as null rather than guessing", () => {
    const json = JSON.stringify([{ modelKey: "a" }, { modelKey: "b", contextLength: 0 }]);
    expect(parseLmsPs(json).map((m) => m.contextLength)).toEqual([null, null]);
  });

  it("accepts the snake_case spelling some lms versions emit", () => {
    const json = JSON.stringify([{ modelKey: "a", context_length: 8192 }]);
    expect(parseLmsPs(json)[0]?.contextLength).toBe(8192);
  });
});

/**
 * The context pre-flight refuses requests, so this picker must return null —
 * "do not check" — for every case where the answer is not actually knowable.
 */
describe("pickLoadedContextTokens", () => {
  const loaded = (rows: unknown[]): ReturnType<typeof parseLmsPs> => parseLmsPs(JSON.stringify(rows));

  it("returns the context of the only loaded model when none was named", () => {
    expect(pickLoadedContextTokens(loaded([{ modelKey: "a", contextLength: 16384 }]), undefined)).toBe(
      16384
    );
  });

  it("matches the named model across the id spellings lms reports", () => {
    const rows = loaded([
      { modelKey: "other", contextLength: 4096 },
      { modelKey: "mlx/Qwen", identifier: "qwen-served", contextLength: 32768 },
    ]);
    expect(pickLoadedContextTokens(rows, "qwen-served")).toBe(32768);
    expect(pickLoadedContextTokens(rows, "MLX/QWEN")).toBe(32768);
  });

  it("declines when several models are loaded and none was named", () => {
    const rows = loaded([
      { modelKey: "a", contextLength: 4096 },
      { modelKey: "b", contextLength: 32768 },
    ]);
    expect(pickLoadedContextTokens(rows, undefined)).toBeNull();
  });

  it("declines when the named model is not among several loaded ones", () => {
    const rows = loaded([
      { modelKey: "a", contextLength: 4096 },
      { modelKey: "b", contextLength: 32768 },
    ]);
    expect(pickLoadedContextTokens(rows, "not-loaded")).toBeNull();
  });

  it("declines when lms is unavailable or nothing is loaded", () => {
    expect(pickLoadedContextTokens(null, undefined)).toBeNull();
    expect(pickLoadedContextTokens([], undefined)).toBeNull();
  });

  it("declines when the one loaded model reports no context length", () => {
    expect(pickLoadedContextTokens(loaded([{ modelKey: "a" }]), undefined)).toBeNull();
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
