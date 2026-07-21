/**
 * Integration test against the REAL built server over stdio. Proves:
 *  - the entrypoint responds to MCP initialize and tools/list
 *  - exactly the four tools are exposed, with schemas
 *  - a real tools/call round-trip works (status, against a dead endpoint)
 *  - stdout purity: every byte on stdout is JSON-RPC — no stray logging
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTempRoot } from "./helpers.js";

const SERVER = path.join(import.meta.dirname, "..", "dist", "server.js");

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: any;
}

let stdoutRaw = "";
let messages: JsonRpcMessage[] = [];

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out; stdout so far: ${stdoutRaw.slice(0, 2000)}`));
      }
    }, 25);
  });
}

describe("stdio server integration", () => {
  const root = makeTempRoot();
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    // Point at a port that is definitely closed so the status call is offline-safe.
    env: { ...process.env, LM_STUDIO_URL: "http://127.0.0.1:1/v1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrRaw = "";

  beforeAll(async () => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutRaw += chunk.toString("utf8");
      messages = stdoutRaw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as JsonRpcMessage);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrRaw += chunk.toString("utf8");
    });

    const send = (payload: object): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" },
      },
    });
    await waitFor(() => messages.some((m) => m.id === 1));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => messages.some((m) => m.id === 2));
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } });
    await waitFor(() => messages.some((m) => m.id === 3));
  }, 30_000);

  afterAll(() => {
    child.kill();
  });

  it("responds to initialize with the server identity", () => {
    const init = messages.find((m) => m.id === 1);
    expect(init?.result?.serverInfo?.name).toBe("local-coder");
  });

  it("exposes exactly the four tools with complete schemas", () => {
    const list = messages.find((m) => m.id === 2);
    const tools = list?.result?.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["fix", "implement", "scaffold", "status"]);

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(100);
    }
    expect(Object.keys(byName.get("implement")!.inputSchema!.properties!).sort()).toEqual(
      ["context_files", "files", "mode", "profile", "spec"]
    );
    expect(byName.get("implement")!.inputSchema!.required).toEqual(["spec", "files"]);
    expect(Object.keys(byName.get("fix")!.inputSchema!.properties!)).toContain("error_output");
    expect(byName.get("fix")!.inputSchema!.required).toContain("error_output");
    expect(Object.keys(byName.get("scaffold")!.inputSchema!.properties!).sort()).toEqual(
      ["profile", "spec", "target_path"]
    );
  });

  it("serves a real tools/call round-trip (status against a dead endpoint)", () => {
    const call = messages.find((m) => m.id === 3);
    const text = call?.result?.content?.[0]?.text as string;
    const payload = JSON.parse(text) as { reachable: boolean; hint?: string };
    expect(payload.reachable).toBe(false);
    expect(payload.hint).toBe("start LM Studio's server with `lms server start`");
  });

  it("keeps stdout pure: every stdout line is valid JSON-RPC", () => {
    const lines = stdoutRaw.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as JsonRpcMessage; // throws on any stray print
      expect(parsed.jsonrpc).toBe("2.0");
    }
  });

  it("logs go to stderr, not stdout", () => {
    expect(stderrRaw).toContain("[local-coder]");
    expect(stdoutRaw).not.toContain("[local-coder]");
  });
});
