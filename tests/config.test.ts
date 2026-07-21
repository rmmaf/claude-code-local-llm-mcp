import { describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig } from "../src/config.js";

describe("config", () => {
  it("applies documented defaults when env is empty", () => {
    const config = loadConfig({}, "/project");
    expect(config.root).toBe("/project");
    expect(config.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.modelSolo).toBe(DEFAULTS.modelSolo);
    expect(config.modelIde).toBe(DEFAULTS.modelIde);
    expect(config.soloMinFreeGb).toBe(20);
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
        LOCAL_CODER_MODEL_SOLO: "my-solo",
        LOCAL_CODER_MODEL_IDE: "my-ide",
        LOCAL_CODER_SOLO_MIN_FREE_GB: "24",
        LOCAL_CODER_TEMPERATURE: "0",
        LOCAL_CODER_MAX_OUTPUT_TOKENS: "16384",
        LOCAL_CODER_TIMEOUT_MS: "60000",
        LOCAL_CODER_MAX_FILE_KB: "128",
        LOCAL_CODER_MAX_CONTEXT_KB: "256",
      },
      "/p"
    );
    expect(config.baseUrl).toBe("http://192.168.1.10:1234/v1");
    expect(config.modelSolo).toBe("my-solo");
    expect(config.modelIde).toBe("my-ide");
    expect(config.soloMinFreeGb).toBe(24);
    expect(config.temperature).toBe(0); // zero is a valid temperature
    expect(config.maxOutputTokens).toBe(16384);
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxFileKb).toBe(128);
    expect(config.maxContextKb).toBe(256);
  });

  it("falls back to defaults on unparseable numeric env values", () => {
    const config = loadConfig(
      { LOCAL_CODER_TIMEOUT_MS: "banana", LOCAL_CODER_MAX_FILE_KB: "-5" },
      "/p"
    );
    expect(config.timeoutMs).toBe(300_000);
    expect(config.maxFileKb).toBe(256);
  });
});
