import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "../src/config.js";
import type { CommandRunner } from "../src/exec.js";
import type { FetchLike } from "../src/llm-client.js";

export function makeTempRoot(prefix = "local-coder-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    root,
    baseUrl: "http://localhost:1234/v1",
    modelsCsvPath: null,
    memFitFraction: 0.85,
    // First entry is the deterministic fallback pick when no sizes are available.
    models: [
      { model: "test-solo-model", objective: "large capable coder" },
      { model: "test-ide-model", objective: "small fast coder" },
    ],
    temperature: 0.1,
    maxOutputTokens: 8192,
    timeoutMs: 30_000,
    maxFileKb: 256,
    maxContextKb: 512,
    ...overrides,
  };
}

/** A CommandRunner driven by a map of command → stdout. Throws for anything unmapped. */
export function fakeRunner(handlers: Record<string, () => string>): CommandRunner {
  return async (command) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command: ${command}`);
    return handler();
  };
}

/**
 * A CommandRunner where every command fails. Keeps unit tests hermetic on dev
 * machines that actually have `lms` installed: sizes stay unknown, so model
 * selection falls back to catalog order deterministically.
 */
export function noLmsRunner(): CommandRunner {
  return async (command) => {
    throw new Error(`command not available in tests: ${command}`);
  };
}

/** Build a canned `lms ls --json` body from {id, sizeBytes} entries. */
export function lmsListBody(models: Array<{ id: string; sizeBytes: number }>): string {
  return JSON.stringify(models.map((m) => ({ path: m.id, sizeBytes: m.sizeBytes })));
}

export interface ChatBodyOptions {
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
}

/** OpenAI-compatible chat completion response body. */
export function chatBody(content: string, options: ChatBodyOptions = {}): object {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: options.model ?? "test-solo-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: options.promptTokens ?? 100,
      completion_tokens: options.completionTokens ?? 50,
      total_tokens: (options.promptTokens ?? 100) + (options.completionTokens ?? 50),
    },
  };
}

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

export interface QueuedFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/**
 * fetch mock fed from a queue of response bodies. Records every request
 * (URL + parsed JSON body). Throws if called more times than bodies queued.
 */
export function queuedFetch(bodies: object[]): QueuedFetch {
  const queue = [...bodies];
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, init, body: rawBody !== undefined ? JSON.parse(rawBody) : undefined });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`queuedFetch exhausted: unexpected request #${calls.length} to ${url}`);
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { fetchImpl, calls };
}

/** fetch mock that always rejects — the unreachable-endpoint case. */
export function unreachableFetch(): FetchLike {
  return (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:1234");
  }) as FetchLike;
}

export async function writeFileTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

/** Wrap file content in the model's <file> block output format. */
export function fileBlock(relPath: string, content: string): string {
  return `<file path="${relPath}">\n${content}</file>`;
}
