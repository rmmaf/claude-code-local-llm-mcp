/**
 * Live end-to-end smoke test — run this on your Mac against a running
 * LM Studio server. It is NEVER run in CI (CI is fully offline).
 *
 *   lms server start
 *   npm run smoke-test
 *
 * What it does:
 *   1. `status` — checks LM Studio reachability and model availability
 *   2. `implement` — creates a throwaway git repo with one small file, asks
 *      the local model for a trivial change, prints the returned diff, and
 *      verifies it applies cleanly with `git apply`
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { loadModelCatalog } from "../src/models-csv.js";
import { runImplement } from "../src/tools/implement.js";
import { runStatus } from "../src/tools/status.js";

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const RESET = "\u001b[0m";

function pass(message: string): void {
  process.stderr.write(`${GREEN}PASS${RESET} ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${RED}FAIL${RESET} ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  process.stderr.write("local-coder smoke test — requires a running LM Studio server\n\n");

  // Step 1: status
  const config = loadConfig(process.env, process.cwd());
  config.models = await loadModelCatalog(config.modelsCsvPath);
  const status = await runStatus(config);
  process.stderr.write(`${JSON.stringify(status, null, 2)}\n\n`);
  if (!status.reachable) {
    fail(
      `LM Studio is not reachable at ${config.baseUrl} — ${status.hint ?? "start it and retry"}`
    );
  }
  pass(`LM Studio reachable at ${config.baseUrl} (${status.models.length} model(s) listed)`);
  const availableInCatalog = status.catalog.filter((m) => m.available === true);
  process.stderr.write(
    `catalog: ${status.catalog.length} model(s), ${availableInCatalog.length} available in /models, ` +
      `lms ${status.lms_available ? "OK" : "unavailable"}; auto-selection would pick ${status.auto_selection.model}.\n`
  );
  if (availableInCatalog.length === 0) {
    process.stderr.write(
      "warn: no catalog model appears in /models — with JIT loading this can still work, but check " +
        "`lms ls` and the models CSV (LOCAL_CODER_MODELS_CSV) on a failure below.\n"
    );
  }

  // Step 2: toy implement in a throwaway git repo
  const root = mkdtempSync(path.join(os.tmpdir(), "local-coder-smoke-"));
  const file = path.join(root, "greet.py");
  writeFileSync(
    file,
    'def greet(name):\n    return "Hello " + name\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n'
  );
  execFileSync("git", ["init", "-q"], { cwd: root });

  const smokeConfig = loadConfig(process.env, root);
  smokeConfig.models = await loadModelCatalog(smokeConfig.modelsCsvPath);
  process.stderr.write(`\nRunning a toy implement against ${root} (this loads the model — may take a while)...\n`);
  const started = Date.now();
  const result = await runImplement(
    {
      spec:
        "Change greet() to use an f-string and add an exclamation mark, so greet('world') " +
        "returns 'Hello, world!'. Change nothing else.",
      files: ["greet.py"],
      mode: "diff",
    },
    smokeConfig
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  process.stderr.write(`\n--- returned diff -------------------------------------------------\n`);
  process.stderr.write(result.diff);
  process.stderr.write(`-------------------------------------------------------------------\n`);
  process.stderr.write(`summary: ${result.summary}\n`);
  process.stderr.write(
    `model: ${result.model} · ${result.selection_reason} · latency: ${elapsed}s · ` +
      `tokens: ${result.usage.prompt_tokens} in / ${result.usage.completion_tokens} out\n\n`
  );

  if (result.files_changed.length === 0 || result.diff === "") {
    fail("the model returned no changes for the toy spec");
  }

  const patchPath = path.join(root, "smoke.patch");
  writeFileSync(patchPath, result.diff);
  try {
    execFileSync("git", ["apply", "--check", "smoke.patch"], { cwd: root });
    execFileSync("git", ["apply", "smoke.patch"], { cwd: root });
  } catch (error) {
    fail(`git apply rejected the diff: ${error instanceof Error ? error.message : String(error)}`);
  }
  const applied = readFileSync(file, "utf8");
  if (!applied.includes("f\"") && !applied.includes("f'")) {
    process.stderr.write("warn: applied file does not obviously contain an f-string — inspect above.\n");
  }
  pass(`diff applied cleanly with git apply (end-to-end latency ${elapsed}s)`);
  process.stderr.write(`\nAll smoke checks passed. Temp repo: ${root}\n`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
