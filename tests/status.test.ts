import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../src/exec.js";
import { runStatus } from "../src/tools/status.js";
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

/**
 * `fakeRunner` keys on the command alone, so it cannot give `lms ls` and
 * `lms ps` different bodies — which the context window needs, since only `ps`
 * reports a context length.
 */
function lmsSubcommandRunner(bodies: { ls?: string; ps?: string }): CommandRunner {
  return async (command, args) => {
    if (command !== "lms") throw new Error(`unexpected command: ${command}`);
    const body = args[0] === "ps" ? bodies.ps : args[0] === "ls" ? bodies.ls : undefined;
    if (body === undefined) throw new Error(`no canned body for: lms ${args.join(" ")}`);
    return body;
  };
}

describe("status context window", () => {
  const psBody = JSON.stringify([
    { modelKey: "test-solo-model", contextLength: 16_384, maxContextLength: 262_144 },
  ]);

  it("reports the window probed from lms, and how much a reload could buy", async () => {
    const { fetchImpl } = queuedFetch([{ data: [{ id: "test-solo-model" }] }]);
    const result = await runStatus(testConfig(makeTempRoot()), {
      fetchImpl,
      platform: "linux",
      runner: lmsSubcommandRunner({ ls: lmsListBody([]), ps: psBody }),
    });

    expect(result.context_window.tokens).toBe(16_384);
    expect(result.context_window.source).toBe("lms");
    expect(result.context_window.max_tokens).toBe(262_144);
  });

  /**
   * The explicit setting used to WIN, and that was the dangerous way round.
   * `LOCAL_CODER_CONTEXT_TOKENS` is a belief; `lms ps` is an observation. A
   * model explicitly loaded at 32,768 was found loaded at 16,384 — the default —
   * with the server up and nobody having touched the configuration, so a
   * declared window can go stale on its own. Believing it then admits requests
   * the model cannot honour, which come back closed, well-formed and short.
   *
   * The smaller wins because the failure is asymmetric: too small costs a
   * refusal the caller can retry, too large costs content nobody notices is
   * gone. And the disagreement is REPORTED rather than quietly resolved, because
   * either number could be the stale one.
   */
  it("takes the smaller window and reports the disagreement", async () => {
    const { fetchImpl } = queuedFetch([{ data: [{ id: "test-solo-model" }] }]);
    const result = await runStatus(testConfig(makeTempRoot(), { contextTokens: 32_768 }), {
      fetchImpl,
      platform: "linux",
      runner: lmsSubcommandRunner({ ls: lmsListBody([]), ps: psBody }),
    });

    expect(result.context_window.tokens).toBe(16_384);
    expect(result.context_window.source).toBe("disagreement");
    expect(result.context_window.configured_tokens).toBe(32_768);
    expect(result.context_window.probed_tokens).toBe(16_384);
    // The raw setting is still reported as configured, unchanged.
    expect(result.config.context_tokens).toBe(32_768);
  });

  it("reports source 'config' when the two agree, with no disagreement flag", async () => {
    const { fetchImpl } = queuedFetch([{ data: [{ id: "test-solo-model" }] }]);
    const result = await runStatus(testConfig(makeTempRoot(), { contextTokens: 16_384 }), {
      fetchImpl,
      platform: "linux",
      runner: lmsSubcommandRunner({ ls: lmsListBody([]), ps: psBody }),
    });

    expect(result.context_window.tokens).toBe(16_384);
    expect(result.context_window.source).toBe("config");
  });

  /** Nothing loaded to contradict it, so the configured value stands alone. */
  it("uses the explicit setting when the probe cannot answer", async () => {
    const { fetchImpl } = queuedFetch([{ data: [] }]);
    const result = await runStatus(testConfig(makeTempRoot(), { contextTokens: 32_768 }), {
      fetchImpl,
      platform: "linux",
      runner: noLmsRunner(),
    });

    expect(result.context_window.tokens).toBe(32_768);
    expect(result.context_window.source).toBe("config");
    expect(result.context_window.probed_tokens).toBeNull();
  });

  /**
   * The case worth surfacing loudest: nothing loaded and nothing configured
   * means the context pre-flight is switched OFF, and a user seeing
   * whole-file answers come back short needs to be able to find that out.
   */
  it("reports source 'unknown' when the window cannot be determined", async () => {
    const { fetchImpl } = queuedFetch([{ data: [] }]);
    const result = await runStatus(testConfig(makeTempRoot()), {
      fetchImpl,
      platform: "linux",
      runner: noLmsRunner(),
    });

    expect(result.context_window.tokens).toBeNull();
    expect(result.context_window.source).toBe("unknown");
    expect(result.config.context_tokens).toBeNull();
  });
});

describe("status", () => {
  it("reports reachable: false with the lms hint when the endpoint is down — and never throws", async () => {
    const result = await runStatus(testConfig(makeTempRoot()), {
      fetchImpl: unreachableFetch(),
      platform: "linux",
      runner: noLmsRunner(),
    });

    expect(result.reachable).toBe(false);
    expect(result.hint).toBe("start LM Studio's server with `lms server start`");
    expect(result.models).toEqual([]);
    expect(result.lms_available).toBe(false);
    // The catalog is still reported; availability is null when /models is unreachable.
    expect(result.catalog.map((c) => c.model)).toEqual(["test-solo-model", "test-ide-model"]);
    expect(result.catalog[0]?.available).toBeNull();
    // No sizes available -> the memory-only fallback picks the first catalog entry.
    expect(result.auto_selection.model).toBe("test-solo-model");
    expect(result.config.base_url).toBe("http://localhost:1234/v1");
    expect(result.config.models_csv_path).toBeNull();
  });

  it("marks catalog availability and sizes when reachable with lms", async () => {
    const { fetchImpl, calls } = queuedFetch([
      { object: "list", data: [{ id: "test-solo-model" }, { id: "some-other-model" }] },
    ]);
    const runner = fakeRunner({
      lms: () =>
        lmsListBody([
          { id: "test-solo-model", sizeBytes: 18 * GB },
          { id: "test-ide-model", sizeBytes: 8 * GB },
        ]),
    });
    const result = await runStatus(testConfig(makeTempRoot()), { fetchImpl, platform: "linux", runner });

    expect(calls[0]?.url).toBe("http://localhost:1234/v1/models");
    expect(result.reachable).toBe(true);
    expect(result.lms_available).toBe(true);
    expect(result.hint).toBeUndefined();
    expect(result.models).toEqual(["test-solo-model", "some-other-model"]);

    const solo = result.catalog.find((c) => c.model === "test-solo-model");
    const ide = result.catalog.find((c) => c.model === "test-ide-model");
    expect(solo?.available).toBe(true);
    expect(solo?.size_gb).toBe(18);
    expect(ide?.available).toBe(false);
    expect(ide?.size_gb).toBe(8);
    expect(result.memory).not.toBeNull();
    expect(result.config.max_file_kb).toBe(256);
  });

  it("does not throw on a malformed /models response", async () => {
    const { fetchImpl } = queuedFetch([{ unexpected: "shape" }]);
    const result = await runStatus(testConfig(makeTempRoot()), {
      fetchImpl,
      platform: "linux",
      runner: noLmsRunner(),
    });
    expect(result.reachable).toBe(false);
    expect(result.hint).toBe("start LM Studio's server with `lms server start`");
  });
});
