import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCatalog,
  deriveObjectiveFromName,
  encodeCatalog,
  objectiveFromMeta,
  runGenerateCatalog,
} from "../src/generate-catalog.js";
import type { FetchLike } from "../src/llm-client.js";
import { type ModelEntry, parseModelsCsv } from "../src/models-csv.js";
import { fakeRunner, lmsListBody, makeTempRoot, noLmsRunner } from "./helpers.js";

/** A representative `lms ls` inventory: a big coder, a mid coder, a small embedder. */
const SCAN = [
  { id: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2", sizeBytes: 17_179_869_184 },
  { id: "qwen2.5-coder-14b-instruct", sizeBytes: 8_589_934_592 },
  { id: "text-embedding-nomic-embed-text-v1.5", sizeBytes: 84_934_656 },
];
const lmsBody = lmsListBody(SCAN);

interface Route {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
}

/** A fetch mock that routes by URL and 404s anything unmatched. Records calls. */
function routedFetch(routes: Route[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { fetchImpl, calls };
}

const throwingFetch = (async () => {
  throw new TypeError("fetch failed");
}) as FetchLike;

describe("generate-catalog: CSV encoding", () => {
  it("encodes a catalog that round-trips through parseModelsCsv", () => {
    const entries: ModelEntry[] = [
      { model: "plain/model", objective: "simple objective" },
      { model: "big/coder", objective: "Large, capable — code generation and refactoring" }, // comma
      { model: "weird/model", objective: 'has a "quote" and, a comma' }, // quote + comma
      { model: "no/objective", objective: "" },
    ];
    expect(parseModelsCsv(encodeCatalog(entries))).toEqual(entries);
  });
});

describe("generate-catalog: objective derivation", () => {
  it("derives objectives from the model name + size", () => {
    expect(
      deriveObjectiveFromName("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2", 17_179_869_184)
    ).toBe("Large, capable — code generation and refactoring");
    expect(deriveObjectiveFromName("qwen2.5-coder-14b-instruct", 8_589_934_592)).toBe(
      "Code generation and refactoring"
    );
    expect(deriveObjectiveFromName("text-embedding-nomic-embed-text-v1.5", 84_934_656)).toBe(
      "Small, fast — text embeddings and semantic search"
    );
    expect(deriveObjectiveFromName("some-random-model", null)).toBe("General-purpose local model");
  });

  it("composes objectives from Hugging Face metadata", () => {
    expect(
      objectiveFromMeta({ pipelineTag: "text-generation", tags: ["code"] }, "some/model", 20_000_000_000)
    ).toBe("Large, capable — code generation and refactoring");
    expect(objectiveFromMeta({ pipelineTag: "feature-extraction" }, "some/thing", 100_000_000)).toBe(
      "Small, fast — text embeddings and semantic search"
    );
    expect(
      objectiveFromMeta({ pipelineTag: "text-generation", tags: ["conversational"] }, "some/assistant", 9_000_000_000)
    ).toBe("General instruction-following and chat");
  });
});

describe("generate-catalog: buildCatalog", () => {
  it("(offline) derives objectives and preserves existing entries", async () => {
    const scanned = SCAN.map((m) => ({ model: m.id, sizeBytes: m.sizeBytes }));
    const existing: ModelEntry[] = [{ model: "qwen2.5-coder-14b-instruct", objective: "KEEP ME" }];
    const res = await buildCatalog(scanned, existing, {
      offline: true,
      fetchImpl: throwingFetch, // must not be called when offline
      hfTimeoutMs: 1000,
    });
    expect(res.entries.find((e) => e.model === "qwen2.5-coder-14b-instruct")?.objective).toBe("KEEP ME");
    expect(res.preserved).toContain("qwen2.5-coder-14b-instruct");
    expect(res.added).toContain("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2");
    expect(res.entries.find((e) => e.model.startsWith("mlx-community"))?.objective).toBe(
      "Large, capable — code generation and refactoring"
    );
  });

  it("(online) uses Hugging Face metadata via direct GET, inline search, and detail fallback", async () => {
    const { fetchImpl, calls } = routedFetch([
      // full-id direct GET hit
      {
        match: (u) =>
          u === "https://huggingface.co/api/models/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
        body: { pipeline_tag: "text-generation", tags: ["code", "mlx"] },
      },
      // no-slash id → search returns a hit with inline metadata
      {
        match: (u) => u.startsWith("https://huggingface.co/api/models?search=qwen2.5-coder-14b-instruct"),
        body: [{ id: "Qwen/Qwen2.5-Coder-14B-Instruct", downloads: 1000, pipeline_tag: "text-generation", tags: ["code"] }],
      },
      // no-slash id → search hit WITHOUT inline metadata → forces a detail GET
      {
        match: (u) => u.startsWith("https://huggingface.co/api/models?search=text-embedding-nomic-embed-text-v1.5"),
        body: [{ id: "nomic-ai/nomic-embed-text-v1.5", downloads: 500 }],
      },
      {
        match: (u) => u === "https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5",
        body: { pipeline_tag: "feature-extraction", tags: ["sentence-transformers"] },
      },
    ]);
    const scanned = SCAN.map((m) => ({ model: m.id, sizeBytes: m.sizeBytes }));
    const res = await buildCatalog(scanned, [], { offline: false, fetchImpl, hfTimeoutMs: 1000 });
    const obj = (model: string): string | undefined => res.entries.find((e) => e.model === model)?.objective;
    expect(obj("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2")).toBe(
      "Large, capable — code generation and refactoring"
    );
    expect(obj("qwen2.5-coder-14b-instruct")).toBe("Code generation and refactoring");
    expect(obj("text-embedding-nomic-embed-text-v1.5")).toBe(
      "Small, fast — text embeddings and semantic search"
    );
    // the detail GET was needed for the metadata-less search hit
    expect(calls).toContain("https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5");
  });

  it("(online) falls back to the name heuristic when Hugging Face is unreachable", async () => {
    const res = await buildCatalog([{ model: "qwen2.5-coder-14b-instruct", sizeBytes: 8_589_934_592 }], [], {
      offline: false,
      fetchImpl: throwingFetch,
      hfTimeoutMs: 1000,
    });
    expect(res.entries[0]?.objective).toBe("Code generation and refactoring");
  });
});

describe("generate-catalog: runGenerateCatalog", () => {
  it("writes a CSV to stdout from an `lms ls` scan", async () => {
    let out = "";
    const code = await runGenerateCatalog(["--offline"], {
      runner: fakeRunner({ lms: () => lmsBody }),
      fetchImpl: throwingFetch,
      env: {},
      cwd: makeTempRoot(),
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    const entries = parseModelsCsv(out);
    expect(entries.map((e) => e.model)).toEqual(SCAN.map((m) => m.id));
    expect(entries.find((e) => e.model === "text-embedding-nomic-embed-text-v1.5")?.objective).toBe(
      "Small, fast — text embeddings and semantic search"
    );
  });

  it("merges into an existing --out, preserving objectives and skipping their lookup", async () => {
    const root = makeTempRoot();
    const outPath = path.join(root, "models.csv");
    await fs.writeFile(outPath, "qwen2.5-coder-14b-instruct,MY CUSTOM OBJECTIVE\n", "utf8");
    const { fetchImpl, calls } = routedFetch([
      {
        match: (u) =>
          u === "https://huggingface.co/api/models/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2",
        body: { pipeline_tag: "text-generation", tags: ["code"] },
      },
      // catch-all for the remaining (embedder) lookups
      { match: (u) => u.includes("/api/models"), body: { pipeline_tag: "text-generation", tags: [] } },
    ]);
    const code = await runGenerateCatalog(["--out", outPath], {
      runner: fakeRunner({ lms: () => lmsBody }),
      fetchImpl,
      env: {},
      cwd: root,
      stderr: () => {},
    });
    expect(code).toBe(0);
    const entries = parseModelsCsv(await fs.readFile(outPath, "utf8"));
    expect(entries.find((e) => e.model === "qwen2.5-coder-14b-instruct")?.objective).toBe("MY CUSTOM OBJECTIVE");
    expect(entries.some((e) => e.model === "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-dwq-v2")).toBe(true);
    // the already-present model was never looked up on Hugging Face
    expect(calls.some((u) => u.includes("qwen2.5-coder-14b-instruct"))).toBe(false);
  });

  it("falls back to the /models endpoint when `lms` is unavailable (sizeless)", async () => {
    const { fetchImpl } = routedFetch([
      { match: (u) => u.endsWith("/v1/models"), body: { data: [{ id: "mystery-chat-model" }] } },
    ]);
    let out = "";
    const code = await runGenerateCatalog(["--offline"], {
      runner: noLmsRunner(),
      fetchImpl,
      env: {},
      cwd: makeTempRoot(),
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(parseModelsCsv(out)).toEqual([
      { model: "mystery-chat-model", objective: "General instruction-following and chat" },
    ]);
  });

  it("returns exit code 1 when no models can be found", async () => {
    const code = await runGenerateCatalog(["--offline"], {
      runner: noLmsRunner(),
      fetchImpl: throwingFetch,
      env: {},
      cwd: makeTempRoot(),
      stderr: () => {},
    });
    expect(code).toBe(1);
  });
});
