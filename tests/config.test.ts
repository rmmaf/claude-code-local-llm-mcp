import { describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig } from "../src/config.js";

describe("config", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({}, "/project");
    expect(config.root).toBe("/project");
    expect(config.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.modelsCsvPath).toBeNull();
    expect(config.memFitFraction).toBe(DEFAULTS.memFitFraction);
    expect(config.models).toEqual([]);
    expect(config.temperature).toBe(0.1);
    expect(config.maxOutputTokens).toBe(8192);
    expect(config.timeoutMs).toBe(300_000);
    expect(config.maxFileKb).toBe(256);
    expect(config.maxContextKb).toBe(512);
  });

  it("honors env overrides and trims trailing slashes off the base URL", () => {
    const config = loadConfig(
      {
        LM_STUDIO_URL: "http://192.168.1.10:1234/v1/",
        LOCAL_CODER_MODELS_CSV: "/etc/local-coder/models.csv",
        LOCAL_CODER_MEM_FIT_FRACTION: "0.7",
        LOCAL_CODER_TEMPERATURE: "0",
        LOCAL_CODER_MAX_OUTPUT_TOKENS: "16384",
        LOCAL_CODER_TIMEOUT_MS: "60000",
        LOCAL_CODER_MAX_FILE_KB: "128",
        LOCAL_CODER_MAX_CONTEXT_KB: "256",
      },
      "/p"
    );
    expect(config.baseUrl).toBe("http://192.168.1.10:1234/v1");
    expect(config.modelsCsvPath).toBe("/etc/local-coder/models.csv");
    expect(config.memFitFraction).toBe(0.7);
    expect(config.temperature).toBe(0); // zero is a valid temperature
    expect(config.maxOutputTokens).toBe(16384);
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxFileKb).toBe(128);
    expect(config.maxContextKb).toBe(256);
  });

  it("resolves a relative models CSV path against the project root", () => {
    const config = loadConfig({ LOCAL_CODER_MODELS_CSV: "config/models.csv" }, "/project");
    expect(config.modelsCsvPath).toBe("/project/config/models.csv");
  });

  it("clamps a mem fit fraction above 1 down to 1", () => {
    expect(loadConfig({ LOCAL_CODER_MEM_FIT_FRACTION: "1.5" }, "/p").memFitFraction).toBe(1);
  });

  it("falls back to defaults on unparseable numeric env values", () => {
    const config = loadConfig(
      {
        LOCAL_CODER_TIMEOUT_MS: "banana",
        LOCAL_CODER_MAX_FILE_KB: "-5",
        LOCAL_CODER_MEM_FIT_FRACTION: "nope",
      },
      "/p"
    );
    expect(config.timeoutMs).toBe(300_000);
    expect(config.maxFileKb).toBe(256);
    expect(config.memFitFraction).toBe(DEFAULTS.memFitFraction);
  });
});
