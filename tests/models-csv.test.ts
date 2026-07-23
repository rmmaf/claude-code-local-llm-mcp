import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL_CATALOG, loadModelCatalog, parseModelsCsv } from "../src/models-csv.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const modelsCsvFixture = readFileSync(path.join(FIXTURES, "models.csv"), "utf8");

describe("parseModelsCsv", () => {
  it("parses two columns, skipping comment and blank lines, honoring quoted commas", () => {
    const entries = parseModelsCsv(modelsCsvFixture);
    expect(entries).toEqual([
      {
        model: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
        objective: "Large capable general code generation and multi-file refactoring",
      },
      {
        model: "qwen2.5-coder-14b-instruct",
        objective: "Smaller, faster coding model for low memory, or concurrent agents",
      },
    ]);
  });

  it("handles CRLF and escaped double-quotes inside a quoted objective", () => {
    const csv = 'model-a,plain objective\r\nmodel-b,"an ""escaped"" quote, and a comma"\r\n';
    expect(parseModelsCsv(csv)).toEqual([
      { model: "model-a", objective: "plain objective" },
      { model: "model-b", objective: 'an "escaped" quote, and a comma' },
    ]);
  });

  it("gives a single-column row an empty objective and ignores extra columns", () => {
    const csv = "only-model\nm,obj,extra,cols\n";
    expect(parseModelsCsv(csv)).toEqual([
      { model: "only-model", objective: "" },
      { model: "m", objective: "obj" },
    ]);
  });

  it("returns [] for an all-comment / all-blank file", () => {
    expect(parseModelsCsv("# just a comment\n\n   \n")).toEqual([]);
  });
});

describe("loadModelCatalog", () => {
  it("returns the default catalog when the path is null", async () => {
    expect(await loadModelCatalog(null)).toBe(DEFAULT_MODEL_CATALOG);
  });

  it("reads and parses a CSV via the injected reader", async () => {
    const entries = await loadModelCatalog("/x/models.csv", async () => "m1,o1\nm2,o2\n");
    expect(entries).toEqual([
      { model: "m1", objective: "o1" },
      { model: "m2", objective: "o2" },
    ]);
  });

  it("falls back to the default catalog when the file cannot be read", async () => {
    const entries = await loadModelCatalog("/missing.csv", async () => {
      throw new Error("ENOENT");
    });
    expect(entries).toBe(DEFAULT_MODEL_CATALOG);
  });

  it("falls back to the default catalog when the CSV has no usable rows", async () => {
    expect(await loadModelCatalog("/empty.csv", async () => "# only a comment\n")).toBe(
      DEFAULT_MODEL_CATALOG
    );
  });
});
