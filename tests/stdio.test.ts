/**
 * Integration test against the REAL built server over stdio. Proves:
 *  - the entrypoint responds to MCP initialize and tools/list
 *  - exactly the seven tools are exposed, with schemas
 *  - a real tools/call round-trip works (status, against a dead endpoint)
 *  - stdout purity: every byte on stdout is JSON-RPC — no stray logging
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

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
const messages: JsonRpcMessage[] = [];
let spawnError: Error | null = null;

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (spawnError !== null) {
        // Naming the spawn failure beats waiting out the timeout and then reporting an
        // empty stdout, which describes the symptom and hides the cause.
        clearInterval(timer);
        reject(new Error(`server process failed to spawn: ${spawnError.message}`));
      } else if (predicate()) {
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
  let child: ChildProcessWithoutNullStreams | undefined;
  let stderrRaw = "";
  /**
   * COMPLETE lines that were not valid JSON. Collected, never thrown from the `data`
   * handler: a throw there is an Unhandled Error, which vitest reports with ZERO failing
   * tests and no line number — the least readable form a real stray-print regression
   * could take. Asserted empty by the stdout-purity test below.
   */
  const unparseable: string[] = [];

  beforeAll(async () => {
    // Spawned HERE and not in the describe body. A describe body runs at COLLECT time, so
    // the old placement started the server during collection and left it running if the
    // file was collected but never run — an orphan holding `root`, with no afterAll to
    // reap it.
    const proc = spawn(process.execPath, [SERVER], {
      cwd: root,
      // Point at a port that is definitely closed so the status call is offline-safe.
      env: { ...process.env, LM_STUDIO_URL: "http://127.0.0.1:1/v1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    proc.on("error", (err: Error) => {
      spawnError = err;
    });

    // Only COMPLETE lines are parsed, and the remainder is carried to the next chunk. A
    // chunk boundary landing mid-message is legal on a pipe and is not a malformed
    // message. MEASURED 2026-08-14, 20 runs: every run delivered exactly one chunk per
    // message and this never fired. It is written for the day that stops holding — a
    // longer tools/list, a different OS, a busier scheduler — not for an observed
    // failure. See PREMISES.md.
    // TWO boundaries, and they are independent. `outDecoder` holds back an incomplete
    // UTF-8 SEQUENCE; `pending` holds back an incomplete LINE. The decoder is not
    // decoration: stdout carries 105 non-ASCII bytes (measured 2026-08-14), all of them
    // U+2014 EM DASH written as `e2 80 94` inside tool descriptions. A boundary landing
    // mid-sequence under the old `chunk.toString("utf8")` yields U+FFFD on both sides —
    // and that JSON still PARSES, so it would have corrupted a description silently and
    // left the purity assertion green. The dropped throw was the visible half of this.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let pending = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = outDecoder.write(chunk);
      stdoutRaw += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          messages.push(JSON.parse(line) as JsonRpcMessage);
        } catch {
          unparseable.push(line);
        }
      }
    });
    // The stream can end on an unterminated line. Without this the last line would sit in
    // `pending` forever, reaching neither `messages` nor `unparseable` — the one input the
    // line buffer would otherwise swallow rather than judge.
    proc.stdout.on("end", () => {
      pending += outDecoder.end();
      if (pending.trim() !== "") {
        try {
          messages.push(JSON.parse(pending) as JsonRpcMessage);
        } catch {
          unparseable.push(pending);
        }
      }
      pending = "";
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrRaw += errDecoder.write(chunk);
    });
    proc.stderr.on("end", () => {
      stderrRaw += errDecoder.end();
    });

    const send = (payload: object): void => {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
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

  afterAll(async () => {
    const proc = child;
    // `spawnError` first: on a spawn failure there is no process, both `exitCode` and
    // `signalCode` stay null, `kill()` does nothing and `'exit'` may never fire — so
    // without this the teardown would spend the full timeout waiting on nothing.
    if (proc === undefined || spawnError !== null) return;
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      });
      proc.kill();
      // Bounded on purpose: a child that ignores the signal must not hang the suite. The
      // wait is what lets `root` be released before the temp-root sweep reaches it, which
      // on Windows is the difference between a clean sweep and a locked directory.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const giveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      });
      await Promise.race([exited, giveUp]);
      if (timer !== undefined) clearTimeout(timer);
      // A signal the child ignored leaves it holding `root`. SIGTERM asked; this tells.
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    // ASSERTED HERE AND NOT ONLY IN THE PURITY TEST. The old handler threw on a bad line
    // at any moment in the child's life; a single assertion inside test 4 of 5 is live
    // only while that test runs, so stray output during test 5 or teardown would be
    // collected and never judged. This restores the old temporal coverage without
    // restoring the unreadable failure form.
    //
    // Joined rather than `toEqual([])` because the whole point is readability, and the
    // array form reports "expected [ Array(1) ] to deeply equal []" — which hides the one
    // thing the reader needs, the offending line.
    expect(unparseable.join("\n")).toBe("");
  });

  it("responds to initialize with the server identity", () => {
    const init = messages.find((m) => m.id === 1);
    expect(init?.result?.serverInfo?.name).toBe("local-coder");
  });

  it("exposes exactly the seven tools with complete schemas", () => {
    const list = messages.find((m) => m.id === 2);
    const tools = list?.result?.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fix",
      "gate",
      "implement",
      "models",
      "repair",
      "scaffold",
      "status",
    ]);

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(100);
    }
    expect(Object.keys(byName.get("implement")!.inputSchema!.properties!).sort()).toEqual(
      ["context_files", "files", "mode", "model", "spec"]
    );
    expect(byName.get("implement")!.inputSchema!.required).toEqual(["spec", "files"]);
    expect(Object.keys(byName.get("fix")!.inputSchema!.properties!)).toContain("error_output");
    expect(byName.get("fix")!.inputSchema!.required).toContain("error_output");
    expect(Object.keys(byName.get("scaffold")!.inputSchema!.properties!).sort()).toEqual(
      ["model", "spec", "target_path"]
    );
    expect(Object.keys(byName.get("models")!.inputSchema!.properties!)).toContain("concurrent_models");
    expect(Object.keys(byName.get("gate")!.inputSchema!.properties!).sort()).toEqual([
      "checks",
      "max_failures",
    ]);
    expect(Object.keys(byName.get("repair")!.inputSchema!.properties!).sort()).toEqual([
      "budget_seconds",
      "checks",
      "context_files",
      "files",
      "max_rounds",
      "model",
      "spec",
    ]);
    expect(byName.get("repair")!.inputSchema!.required!.sort()).toEqual(["files", "spec"]);
  });

  it("serves a real tools/call round-trip (status against a dead endpoint)", () => {
    const call = messages.find((m) => m.id === 3);
    const text = call?.result?.content?.[0]?.text as string;
    const payload = JSON.parse(text) as { reachable: boolean; hint?: string };
    expect(payload.reachable).toBe(false);
    expect(payload.hint).toBe("start LM Studio's server with `lms server start`");
  });

  it("keeps stdout pure: every stdout line is valid JSON-RPC", () => {
    // The live reader's verdict, which names the offending line instead of throwing
    // where vitest can only report it as an Unhandled Error.
    expect(unparseable.join("\n")).toBe("");
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
