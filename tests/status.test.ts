import { describe, expect, it } from "vitest";

import { runStatus } from "../src/tools/status.js";
import { makeTempRoot, queuedFetch, testConfig, unreachableFetch } from "./helpers.js";

describe("status", () => {
  it("reports reachable: false with the lms hint when the endpoint is down — and never throws", async () => {
    const result = await runStatus(testConfig(makeTempRoot()), { fetchImpl: unreachableFetch(), platform: "linux" });

    expect(result.reachable).toBe(false);
    expect(result.hint).toBe("start LM Studio's server with `lms server start`");
    expect(result.models).toEqual([]);
    expect(result.profile_models.solo.available).toBeNull();
    expect(result.profile_models.ide.available).toBeNull();
    expect(result.auto_profile.profile).toBe("solo"); // injected platform "linux" -> solo, deterministic
    expect(result.config.base_url).toBe("http://localhost:1234/v1");
  });

  it("lists models and flags configured profile models when reachable", async () => {
    const { fetchImpl, calls } = queuedFetch([
      {
        object: "list",
        data: [{ id: "test-solo-model" }, { id: "some-other-model" }],
      },
    ]);
    const result = await runStatus(testConfig(makeTempRoot()), { fetchImpl, platform: "linux" });

    expect(calls[0]?.url).toBe("http://localhost:1234/v1/models");
    expect(result.reachable).toBe(true);
    expect(result.hint).toBeUndefined();
    expect(result.models).toEqual(["test-solo-model", "some-other-model"]);
    expect(result.profile_models.solo).toEqual({ id: "test-solo-model", available: true });
    expect(result.profile_models.ide).toEqual({ id: "test-ide-model", available: false });
    expect(result.memory).not.toBeNull();
    expect(result.config.max_file_kb).toBe(256);
  });

  it("does not throw on a malformed /models response", async () => {
    const { fetchImpl } = queuedFetch([{ unexpected: "shape" }]);
    const result = await runStatus(testConfig(makeTempRoot()), { fetchImpl, platform: "linux" });
    expect(result.reachable).toBe(false);
    expect(result.hint).toBe("start LM Studio's server with `lms server start`");
  });
});
