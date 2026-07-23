import { promises as fs } from "node:fs";

import { log } from "./logger.js";

export interface ModelEntry {
  /** Model name exactly as LM Studio references it — sent verbatim as the chat `model`. */
  model: string;
  /** Free-text English description of what the model is good for. */
  objective: string;
}

/**
 * Built-in catalog used when no CSV is configured, so a zero-config install
 * keeps working. These are the two models this server historically shipped.
 */
export const DEFAULT_MODEL_CATALOG: ModelEntry[] = [
  {
    model: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
    objective: "Large, capable general code generation and multi-file refactoring when RAM allows",
  },
  {
    model: "qwen2.5-coder-14b-instruct",
    objective: "Smaller, faster coding model for low-memory situations or concurrent agents",
  },
];

/**
 * Split CSV text into records of fields, honoring double-quoted fields (which
 * may contain commas, escaped `""` quotes, and newlines) per RFC-4180. Kept
 * minimal — enough that an `objective` can contain a comma.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let sawField = false;

  const endField = (): void => {
    record.push(field);
    field = "";
    sawField = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    sawField = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  // Flush a trailing record that wasn't newline-terminated.
  if (field !== "" || sawField || record.length > 0) endRecord();
  return records;
}

/**
 * Parse the models CSV (no header, two columns: model, objective). Blank lines
 * and `#` comment lines are skipped; a row missing its objective column gets an
 * empty objective (with a warning); extra columns beyond the first two are
 * ignored. Pure and never throws.
 */
export function parseModelsCsv(text: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const record of parseCsvRecords(text)) {
    if (record.every((f) => f.trim() === "")) continue; // blank line
    const model = (record[0] ?? "").trim();
    if (model === "") continue;
    if (model.startsWith("#")) continue; // comment line
    if (record.length < 2) {
      log.warn(`models-csv: row for ${JSON.stringify(model)} has no objective column; using empty objective`);
    } else if (record.length > 2) {
      log.warn(`models-csv: row for ${JSON.stringify(model)} has ${record.length} columns; using only the first two`);
    }
    entries.push({ model, objective: (record[1] ?? "").trim() });
  }
  return entries;
}

/**
 * Load the model catalog from a CSV path. Falls back to DEFAULT_MODEL_CATALOG
 * when the path is unset, unreadable, or yields no usable rows (each logged).
 * The CSV is server configuration outside the project root, so it is read with
 * plain fs.readFile — not the project-scoped path safety used for source files.
 */
export async function loadModelCatalog(
  csvPath: string | null,
  readFileImpl: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8")
): Promise<ModelEntry[]> {
  if (csvPath === null || csvPath.trim() === "") {
    log.info("models-csv: no LOCAL_CODER_MODELS_CSV set; using the built-in default catalog");
    return DEFAULT_MODEL_CATALOG;
  }
  let text: string;
  try {
    text = await readFileImpl(csvPath);
  } catch (error) {
    log.warn(
      `models-csv: could not read ${csvPath}: ${error instanceof Error ? error.message : String(error)}; using the built-in default catalog`
    );
    return DEFAULT_MODEL_CATALOG;
  }
  const entries = parseModelsCsv(text);
  if (entries.length === 0) {
    log.warn(`models-csv: ${csvPath} contained no usable rows; using the built-in default catalog`);
    return DEFAULT_MODEL_CATALOG;
  }
  log.info(`models-csv: loaded ${entries.length} model(s) from ${csvPath}`);
  return entries;
}
