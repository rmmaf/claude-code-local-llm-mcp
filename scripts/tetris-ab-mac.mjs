#!/usr/bin/env node
/**
 * Mac A/B: same Tetris prompt as laptop-01, Claude Code CLI --model opus.
 * Control = empty MCP. Treatment = local-coder + the LM Studio model you pick.
 * Prints the USD / output / cache_read / turns / wall / entrega table.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");

const ORIGINAL_PROMPT =
  "teste um mcp fazeno um jogo de tetris com regras e mecanicas modernas (pesquise na internet quias são). Como o modelo é um 9B forneça o contexto necessário para o Qwen 3.5 Coder 9b Q4_K_S desempenhar bem a função (pesquise na interter como trabalhar com esse modelo). Ligue o reasoning do modelo local. Considere também que  voce é o arquiteto e orquestrador (quem implementar e gera os outputs é o local). Execute isso de modo a economizar os tokens dessa sessão";

const LMS_URL = process.env.LM_STUDIO_URL?.replace(/\/$/, "") || "http://127.0.0.1:1234/v1";
const CONTEXT_LENGTH = Number(process.env.TETRIS_AB_CONTEXT_LENGTH || 16384);
const TIMEOUT_MS = Number(process.env.LOCAL_CODER_TIMEOUT_MS || 600000);
const MCP_TIMEOUT = process.env.MCP_TIMEOUT || "900000";
// Company Mac: never --dangerously-skip-permissions / bypassPermissions.
// B12 on this same machine pre-approves tools with --allowed-tools and
// --permission-mode acceptEdits. Mac 042623Z passed only bypassPermissions,
// got permission_denials, and the 30B never ran.
// --allowed-tools is variadic: one comma-separated value, then a flag that
// starts with `-`, plus `--` before the prompt.
const PERMISSION_MODE = process.env.TETRIS_AB_PERMISSION_MODE || "acceptEdits";
const ALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "mcp__local-coder__status",
  "mcp__local-coder__models",
  "mcp__local-coder__scaffold",
  "mcp__local-coder__implement",
  "mcp__local-coder__gate",
  "mcp__local-coder__repair",
  "mcp__local-coder__fix",
].join(",");

function die(msg) {
  console.error(`erro: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.error(`→ ${msg}`);
}

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return false;
  return /^(1|true|yes|y)$/i.test(v.trim());
}

function lmsEnv() {
  const homeBin = path.join(os.homedir(), ".lmstudio", "bin");
  return {
    ...process.env,
    PATH: `${homeBin}${path.delimiter}${process.env.PATH || ""}`,
  };
}

function resolveBin(name) {
  if (name === "lms") {
    const home = path.join(os.homedir(), ".lmstudio", "bin", "lms");
    if (fileIfExists(home)) return home;
  }
  const hit = findOnPath(name);
  if (hit) return hit;
  if (process.platform === "win32") {
    const cmd = findOnPath(`${name}.cmd`);
    if (cmd) return cmd;
  }
  return null;
}

function runCapture(cmd, args, opts = {}) {
  const resolved = path.isAbsolute(cmd) ? cmd : resolveBin(cmd) || cmd;
  const r = spawnSync(resolved, args, {
    encoding: "utf8",
    env: opts.env || lmsEnv(),
    timeout: opts.timeout ?? 60_000,
    cwd: opts.cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

function fileIfExists(p) {
  if (!p) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const hit = fileIfExists(path.join(dir, name));
    if (hit) return hit;
  }
  return null;
}

function requireNode22() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 19)) return;
  die(
    `Node ${process.versions.node} é antigo demais. undici 8 (timeout local de 600 s) pede ≥ 22.19. O toolchain do Mac B12 é v22.23.`
  );
}

function findClaude() {
  if (process.env.CLAUDE_BIN) {
    if (!fileIfExists(process.env.CLAUDE_BIN)) {
      die(`CLAUDE_BIN não existe ou não é um arquivo: ${process.env.CLAUDE_BIN}`);
    }
    return process.env.CLAUDE_BIN;
  }
  const candidates = [
    findOnPath("claude"),
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const versionsDir = path.join(os.homedir(), ".local", "share", "claude", "versions");
  if (fs.existsSync(versionsDir)) {
    for (const name of fs.readdirSync(versionsDir).sort()) {
      candidates.push(path.join(versionsDir, name));
    }
  }
  for (const p of candidates) {
    if (fileIfExists(p)) return p;
  }
  const extRoot = path.join(os.homedir(), ".cursor", "extensions");
  if (fs.existsSync(extRoot)) {
    const hits = [];
    for (const name of fs.readdirSync(extRoot)) {
      if (!name.startsWith("anthropic.claude-code-")) continue;
      const bin = path.join(extRoot, name, "resources", "native-binary", "claude");
      if (fs.existsSync(bin)) hits.push(bin);
    }
    hits.sort();
    if (hits.length > 0) return hits[hits.length - 1];
  }
  return null;
}

function claudeVersion(bin) {
  const r = runCapture(bin, ["--version"], { timeout: 15000, env: process.env });
  return (r.stdout || r.stderr).trim().split(/\n/)[0] || "unknown";
}

function inspectClaude(bin) {
  const r = runCapture(bin, ["--help"], { timeout: 20000, env: process.env });
  const help = `${r.stdout}\n${r.stderr}`;
  return {
    help,
    streamJson: /stream-json/.test(help),
    verbose: /--verbose\b/.test(help),
    skipPerms: /dangerously-skip-permissions/.test(help),
    allowedTools: /--allowed-tools\b|--allowedTools\b/.test(help),
    print: /--print\b/.test(help),
  };
}

function permissionFlags() {
  if (/bypass|dangerously/i.test(PERMISSION_MODE)) {
    die(
      "TETRIS_AB_PERMISSION_MODE não pode ser bypass/skip: no Mac da empresa --dangerously-skip-permissions é bloqueado. Use acceptEdits (default) ou default. As ferramentas entram por --allowed-tools, como no B12."
    );
  }
  return ["--allowed-tools", ALLOWED_TOOLS, "--permission-mode", PERMISSION_MODE];
}

function writeClaudePermissions(dir) {
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    `${JSON.stringify(
      {
        permissions: {
          defaultMode: PERMISSION_MODE,
          allow: ALLOWED_TOOLS.split(","),
        },
      },
      null,
      2
    )}\n`
  );
}

function buildClaudeArgs({ claudeBin, mcpPath, sessionId, prompt, append }) {
  const caps = inspectClaude(claudeBin);
  if (!caps.print && caps.help.trim() !== "") {
    info("claude --help não listou --print; seguindo mesmo assim (binários pinados às vezes omitem flags no help)");
  }
  // json is the Mac B12 envelope. stream-json in --help is not enough: Claude 2.1.x
  // then requires --verbose, and a missing pair exits in one turn at USD 0.
  const format = envFlag("TETRIS_AB_STREAM_JSON") ? "stream-json" : "json";
  const args = ["--print"];
  if (format === "stream-json") args.push("--verbose");
  args.push("--output-format", format);
  args.push("--model", "opus", "--strict-mcp-config", "--mcp-config", mcpPath);
  args.push(...permissionFlags());
  args.push("--session-id", sessionId, "--append-system-prompt", append, "--", prompt);
  if (args.includes("--dangerously-skip-permissions")) {
    die("argv interno tentou --dangerously-skip-permissions; isso é recusado neste Mac.");
  }
  return { args, format, caps };
}

function claudeFailureText(dir, result, code) {
  const errPath = path.join(dir, ".run", "stderr.txt");
  const streamPath = path.join(dir, ".run", "stream.jsonl");
  const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, "utf8").trim() : "";
  const head = fs.existsSync(streamPath)
    ? fs.readFileSync(streamPath, "utf8").trim().slice(0, 800)
    : "";
  const msg = String(result?.result || result?.errors || "");
  const weekly = /weekly limit|429/i.test(`${msg}\n${stderr}`);
  const denials = denialsOf(result);
  const denialNames = [...new Set(denials.map((d) => d.tool_name).filter(Boolean))];
  return {
    weekly,
    denials: denials.length,
    text: [
      `exit=${code}`,
      result?.is_error != null ? `is_error=${result.is_error}` : "",
      result?.stop_reason ? `stop_reason=${result.stop_reason}` : "",
      denials.length
        ? `permission_denials=${denials.length} (${denialNames.join(", ") || "tools"})`
        : "",
      msg ? `result: ${msg.slice(0, 800)}` : "",
      stderr ? `stderr: ${stderr.slice(-1500)}` : "",
      !stderr && head ? `stdout: ${head}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function denialsOf(result) {
  const d = result?.permission_denials;
  return Array.isArray(d) ? d : [];
}

function hasDenials(result) {
  return denialsOf(result).length > 0;
}

function armFailed(run) {
  if (!run) return true;
  if (run.result?.is_error) return true;
  if (!run.result && run.code !== 0) return true;
  if (hasDenials(run.result)) return true;
  return false;
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const key of ["models", "data", "downloaded"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }
  return [];
}

function idsOfRow(row) {
  if (!row || typeof row !== "object") return [];
  const keys = ["path", "modelKey", "key", "displayName", "identifier", "name", "id"];
  const out = [];
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
  return out;
}

async function fetchServedIds() {
  const r = await fetch(`${LMS_URL}/models`, { signal: AbortSignal.timeout(8000) }).catch(
    () => null
  );
  if (!r || !r.ok) return null;
  const body = await r.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) return [];
  return body.data.map((m) => m.id).filter((id) => typeof id === "string");
}

function firstJsonValue(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  return parseJsonLoose(text.slice(start));
}

function listLmsDownloaded() {
  const r = runCapture("lms", ["ls", "--json"]);
  const parsed = firstJsonValue(r.stdout) || firstJsonValue(r.stderr);
  if (parsed === null) return [];
  const ids = [];
  for (const row of rowsOf(parsed)) {
    for (const id of idsOfRow(row)) ids.push(id);
  }
  return ids;
}

function listLmsLoaded() {
  const r = runCapture("lms", ["ps", "--json"]);
  const parsed = firstJsonValue(r.stdout) || firstJsonValue(r.stderr);
  if (parsed === null) return [];
  return rowsOf(parsed).flatMap((row) => idsOfRow(row));
}

function uniqueKeepOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function collectModels() {
  const served = (await fetchServedIds()) || [];
  const loaded = listLmsLoaded();
  const downloaded = listLmsDownloaded();
  const loadedSet = new Set(
    [...served, ...loaded].map((id) => id.toLowerCase())
  );
  const all = uniqueKeepOrder([...served, ...loaded, ...downloaded]);
  return all.map((id) => ({
    id,
    loaded: loadedSet.has(id.toLowerCase()),
  }));
}

function looksLikeOriginal9bQ4(id) {
  const n = id.toLowerCase();
  if (!/qwen3\.?5[-.]?9b-coder/.test(n) && !/qwen 3\.5 coder 9b/.test(n)) return false;
  if (/8bit|int8|q8/.test(n)) return false;
  return true;
}

function sizeLabelFor(id) {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? `${m[1]}B` : id;
}

function userPromptFor(id) {
  if (looksLikeOriginal9bQ4(id)) return ORIGINAL_PROMPT;
  const size = sizeLabelFor(id);
  return ORIGINAL_PROMPT.replace("um 9B", `um ${size}`).replace(
    "Qwen 3.5 Coder 9b Q4_K_S",
    id
  );
}

function controlAppend() {
  return [
    "CONTROL ARM. The user prompt is reproduced for a token-cost comparison.",
    "This process has no local-coder MCP and no LM Studio (--strict-mcp-config, empty servers).",
    "You (Opus) must implement the Tetris game yourself in the current working directory.",
    "Do not read, copy, or open any sibling directory named tetris-* or any other existing game repo on disk.",
    "This directory starts empty on purpose.",
    "Deliver a browser-playable Guideline Tetris plus automated tests.",
    "When finished, leave the tree runnable (e.g. node serve + npm test).",
  ].join(" ");
}

function treatmentAppend(servedId) {
  return [
    "TREATMENT ARM of a token-cost comparison. The user prompt is the Tetris protocol from 2026-08-24 02:22; the local-model identity is the LM Studio model selected for this Mac run.",
    "This process HAS the local-coder MCP (status, models, scaffold, implement, gate, repair, fix).",
    "You are the architect and orchestrator. The local model writes code.",
    "Rules:",
    `- Pass model "${servedId}" on every scaffold/implement/repair/fix call.`,
    "- New files: scaffold. Existing files: implement. Mechanical red gates: repair. Verify with gate, never by running lint/tsc/tests through Bash.",
    "- Never paste file contents into tool arguments — pass relative paths.",
    "- Escalate to yourself after 2 failed local attempts on the same unit.",
    "- Do not send reasoning_effort none; leave local-model reasoning on.",
    "- Do not read, copy, or open any sibling directory named tetris-* or any other existing game repo on disk. This directory starts empty except the harness in .run.",
    "- Deliver a browser-playable Guideline Tetris plus automated tests. When finished, npm test / gate must be runnable.",
  ].join("\n");
}

async function resolveServedId(wanted) {
  const { matchModel } = await import(pathToFileURL(path.join(REPO, "dist", "selection.js")).href);
  const ids = await fetchServedIds();
  if (ids === null) die(`LM Studio não responde em ${LMS_URL}/models`);
  const m = matchModel(wanted, ids);
  if (m.quality === "none" || !m.value) {
    die(
      `o endpoint não serve ${wanted}. ids atuais: ${ids.join(", ") || "(vazio)"}. Carregue o modelo no LM Studio e tente de novo.`
    );
  }
  return { servedId: m.value, quality: m.quality, servedIds: ids };
}

function writeHarness(dir, arm, prompt, append, sessionId) {
  writeClaudePermissions(dir);
  const runDir = path.join(dir, ".run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "user-prompt.txt"), `${prompt}\n`);
  fs.writeFileSync(path.join(runDir, "append-system.txt"), `${append}\n`);
  fs.writeFileSync(path.join(runDir, "session-id.txt"), `${sessionId}\n`);
  if (arm === "control") {
    fs.writeFileSync(path.join(runDir, "mcp.json"), `${JSON.stringify({ mcpServers: {} })}\n`);
    return;
  }
  const wrapperPath = path.join(runDir, "wrapper.mjs");
  const serverHref = pathToFileURL(path.join(REPO, "dist", "server.js")).href;
  fs.writeFileSync(
    wrapperPath,
    `process.chdir(${JSON.stringify(dir)});\nawait import(${JSON.stringify(serverHref)});\n`
  );
  const mcp = {
    mcpServers: {
      "local-coder": {
        type: "stdio",
        command: "node",
        args: [wrapperPath],
        env: {
          LOCAL_CODER_AUTO_CLAUDE_MD: "1",
          LOCAL_CODER_TIMEOUT_MS: String(TIMEOUT_MS),
          LOCAL_CODER_CONTEXT_TOKENS: String(CONTEXT_LENGTH),
        },
      },
    },
  };
  fs.writeFileSync(path.join(runDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
}

function emptyExtra() {
  return { tools: {}, timeouts: 0, malformed: 0 };
}

function accumulateExtra(extra, o) {
  const content = o?.message?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "tool_use") extra.tools[c.name] = (extra.tools[c.name] || 0) + 1;
    }
  }
  if (o?.type === "user") {
    const blob = JSON.stringify(o);
    if (blob.includes("llm_timeout")) extra.timeouts += 1;
    if (blob.includes("model_output_malformed")) extra.malformed += 1;
  }
}

function coerceResult(o) {
  if (!o || typeof o !== "object") return null;
  if (o.type === "result") return o;
  if (typeof o.total_cost_usd === "number" || typeof o.session_id === "string") return o;
  return null;
}

function extractFromText(text) {
  const extra = emptyExtra();
  let result = null;
  const lines = text.split(/\n/).filter((l) => l.trim());
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    accumulateExtra(extra, o);
    const coerced = coerceResult(o);
    if (coerced) result = coerced;
  }
  if (!result) {
    const parsed = parseJsonLoose(text.trim()) || firstJsonValue(text);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        accumulateExtra(extra, row);
        const coerced = coerceResult(row);
        if (coerced) result = coerced;
      }
    } else {
      const coerced = coerceResult(parsed);
      if (coerced) result = coerced;
    }
  }
  return result ? { ...result, extra } : null;
}

function extractResult(streamPath) {
  if (!fs.existsSync(streamPath)) return null;
  return extractFromText(fs.readFileSync(streamPath, "utf8"));
}

function parserSelfCheck() {
  const stream = extractFromText(
    '{"type":"assistant"}\n{"type":"result","total_cost_usd":1.25,"num_turns":3,"session_id":"s"}\n'
  );
  const envelope = extractFromText(
    '{"total_cost_usd":4.36,"session_id":"s","num_turns":38,"usage":{"output_tokens":1}}\n'
  );
  if (!stream || stream.total_cost_usd !== 1.25 || stream.num_turns !== 3) {
    die("parser interno falhou no formato stream-json");
  }
  if (!envelope || envelope.total_cost_usd !== 4.36 || envelope.num_turns !== 38) {
    die("parser interno falhou no envelope --output-format json (Claude 2.1.221 no Mac)");
  }
}

function opusBlock(result) {
  const mu = result?.modelUsage || {};
  const key = Object.keys(mu).find((k) => /opus/i.test(k));
  return key ? { key, ...mu[key] } : null;
}

function parseTestOutput(text) {
  const vitestFiles = text.match(/Test Files\s+(\d+)\s+passed/);
  const vitest = text.match(/Tests\s+(\d+)\s+passed(?:\s*\((\d+)\))?/);
  if (vitest) {
    const passed = Number(vitest[1]);
    const total = vitest[2] ? Number(vitest[2]) : passed;
    const failM = text.match(/(\d+)\s+failed/);
    const failed = failM ? Number(failM[1]) : Math.max(0, total - passed);
    return { passed, failed, total: passed + failed, kind: "vitest", files: vitestFiles ? Number(vitestFiles[1]) : null };
  }
  const pass = text.match(/# pass (\d+)/);
  const tests = text.match(/# tests (\d+)/);
  const fail = text.match(/# fail (\d+)/);
  if (pass && tests) {
    return {
      passed: Number(pass[1]),
      failed: fail ? Number(fail[1]) : 0,
      total: Number(tests[1]),
      kind: "node --test",
      files: null,
    };
  }
  return null;
}

function countTests(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return { label: "sem suíte", parsed: null, raw: "" };
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    info(`npm install em ${path.basename(dir)}`);
    const inst = runCapture("npm", ["install", "--ignore-scripts"], {
      cwd: dir,
      timeout: 300_000,
    });
    if (inst.status !== 0) {
      return { label: "npm install falhou", parsed: null, raw: inst.stderr };
    }
  }
  const attempts = [
    ["npm", ["test"]],
    ["npx", ["vitest", "run"]],
    ["node", ["--test"]],
  ];
  let last = "";
  for (const [cmd, args] of attempts) {
    const r = runCapture(cmd, args, { cwd: dir, timeout: 180_000 });
    last = `${r.stdout}\n${r.stderr}`;
    const parsed = parseTestOutput(last);
    if (parsed) {
      const label =
        parsed.failed === 0
          ? `${parsed.passed}/${parsed.total} verde`
          : `${parsed.passed}/${parsed.total}`;
      return { label, parsed, raw: last };
    }
  }
  return { label: "suíte ilegível", parsed: null, raw: last };
}

function formatUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(2).replace(".", ",");
}

function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function formatCache(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${(n / 1e6).toFixed(2).replace(".", ",")}M`;
}

function formatApi(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms / 60_000)} min`;
}

function formatWall(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `~${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function outputCell(result) {
  const opus = opusBlock(result);
  const out = opus?.outputTokens ?? result?.usage?.output_tokens;
  const think = result?.usage?.output_tokens_details?.thinking_tokens;
  if (out == null) return "—";
  if (think == null) return formatTokens(out);
  return `${formatTokens(out)} (${formatTokens(think)} thinking)`;
}

function entregaCell(result, tests) {
  if (hasDenials(result)) {
    return `permissões negadas (${denialsOf(result).length})`;
  }
  if (result?.is_error) {
    const msg = String(result.result || result.errors || "");
    if (/weekly limit|429/i.test(msg)) {
      return tests?.parsed ? `${tests.label} · limite` : "incompleto (limite)";
    }
    return tests?.parsed ? `${tests.label} · erro` : "incompleto";
  }
  return tests?.label || "—";
}

function armRow(result, tests, observedWallMs) {
  const opus = opusBlock(result);
  const wall = result?.duration_ms ?? observedWallMs;
  return {
    usd: formatUsd(result?.total_cost_usd),
    output: outputCell(result),
    cache: formatCache(opus?.cacheReadInputTokens ?? result?.usage?.cache_read_input_tokens),
    turnsApi: `${result?.num_turns ?? "—"} / ${formatApi(result?.duration_api_ms)}`,
    wall: formatWall(wall),
    entrega: entregaCell(result, tests),
  };
}

function renderTable(control, treatment) {
  const headers = ["", "Opus só", "Opus + local-coder"];
  const rows = [
    ["USD", control.usd, treatment.usd],
    ["Output Opus", control.output, treatment.output],
    ["cache_read", control.cache, treatment.cache],
    ["Turnos / API", control.turnsApi, treatment.turnsApi],
    ["Wall", control.wall, treatment.wall],
    ["Entrega", control.entrega, treatment.entrega],
  ];
  const widths = [0, 1, 2].map((i) =>
    Math.max(headers[i].length, ...rows.map((r) => String(r[i]).length))
  );
  const fmt = (cols) =>
    `| ${cols.map((c, i) => String(c).padEnd(widths[i], " ")).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

const DEMO_CONTROL = {
  usd: "4,36",
  output: "79,946 (30,299 thinking)",
  cache: "2,72M",
  turnsApi: "38 / 15 min",
  wall: "~15 min",
  entrega: "79/79 verde",
};
const DEMO_TREATMENT = {
  usd: "4,98",
  output: "80,817 (32,354 thinking)",
  cache: "3,48M",
  turnsApi: "57 / 16 min",
  wall: "2 h 11 min",
  entrega: "70/70 verde",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function stampNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

async function askLine(rl, question) {
  const ans = await rl.question(question);
  return ans.trim();
}

async function pickModel(rl, models) {
  const preset = process.env.TETRIS_AB_MODEL?.trim();
  if (preset) {
    const hit = models.find((m) => m.id.toLowerCase() === preset.toLowerCase());
    return hit ? hit.id : preset;
  }
  if (!process.stdin.isTTY) {
    die("stdin não é TTY. Exporte TETRIS_AB_MODEL com o id do LM Studio.");
  }
  if (models.length === 0) {
    die("nenhum modelo no LM Studio. Baixe um no app e/ou rode `lms server start`.");
  }
  console.error("");
  console.error("Modelos no LM Studio:");
  models.forEach((m, i) => {
    const mark = m.loaded ? "carregado" : "baixado";
    console.error(`  ${String(i + 1).padStart(2, " ")}  ${m.id}  [${mark}]`);
  });
  console.error("");
  for (;;) {
    const ans = await askLine(rl, "Qual modelo usar neste teste? (número ou id) ");
    if (!ans) continue;
    const asNum = Number(ans);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= models.length) {
      return models[asNum - 1].id;
    }
    const hit = models.find((m) => m.id.toLowerCase() === ans.toLowerCase());
    if (hit) return hit.id;
    console.error("  não reconheci. Digite o número da lista ou cole o id.");
  }
}

function npmBin() {
  const npm = resolveBin("npm");
  if (!npm) die("npm não está no PATH deste processo. Abra um terminal onde `npm -v` funcione.");
  return npm;
}

function ensureBuilt() {
  const server = path.join(REPO, "dist", "server.js");
  const selection = path.join(REPO, "dist", "selection.js");
  const needCi = !fs.existsSync(path.join(REPO, "node_modules", "undici"));
  const npm = npmBin();
  if (needCi) {
    info("npm ci --ignore-scripts");
    const r = spawnSync(npm, ["ci", "--ignore-scripts"], {
      cwd: REPO,
      stdio: "inherit",
      env: process.env,
    });
    if (r.status !== 0) die("npm ci falhou (rede ou lockfile).");
  }
  if (!fs.existsSync(server) || !fs.existsSync(selection) || envFlag("TETRIS_AB_REBUILD")) {
    info("npm run build");
    const r = spawnSync(npm, ["run", "build"], {
      cwd: REPO,
      stdio: "inherit",
      env: process.env,
    });
    if (r.status !== 0) die("npm run build falhou");
  }
  if (!fs.existsSync(server)) die("dist/server.js ausente depois do build");
  if (!fs.existsSync(path.join(REPO, "node_modules", "undici"))) {
    die("undici não instalou. LOCAL_CODER_TIMEOUT_MS=600000 cairia no teto de 300 s do fetch do Node.");
  }
}

async function verifyBuiltArtifacts() {
  const { matchModel } = await import(pathToFileURL(path.join(REPO, "dist", "selection.js")).href);
  if (typeof matchModel !== "function") die("dist/selection.js não exporta matchModel");
  const undici = await import("undici");
  if (typeof undici.Agent !== "function" || typeof undici.fetch !== "function") {
    die("undici importou mas Agent/fetch não estão disponíveis");
  }
}

async function ensureLmsUp() {
  let ids = await fetchServedIds();
  if (ids !== null) return;
  info("tentando `lms server start`");
  runCapture("lms", ["server", "start"], { timeout: 120_000 });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ids = await fetchServedIds();
    if (ids !== null) return;
  }
  die(`LM Studio não responde em ${LMS_URL}/models. Abra o app, ligue o servidor local e rode de novo.`);
}

function loadModel(id) {
  info(`carregando ${id} (context ${CONTEXT_LENGTH})`);
  const r = runCapture("lms", ["load", id, "-y", "--context-length", String(CONTEXT_LENGTH)], {
    timeout: 600_000,
  });
  if (r.status !== 0) {
    const r2 = runCapture("lms", ["load", id], { timeout: 600_000 });
    if (r2.status !== 0) {
      console.error(r.stderr || r.stdout || r2.stderr);
      die(`não consegui carregar ${id} com lms load`);
    }
  }
}

async function waitServed(id) {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const ids = await fetchServedIds();
    if (ids) {
      const { matchModel } = await import(
        pathToFileURL(path.join(REPO, "dist", "selection.js")).href
      );
      const m = matchModel(id, ids);
      if (m.quality !== "none" && m.value) return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(`timeout de 12 min esperando ${id} aparecer em /v1/models (load de 30B no Mac pode ser lento)`);
}

function gitHead() {
  const r = runCapture("git", ["rev-parse", "HEAD"], { cwd: REPO });
  return r.stdout.trim() || "unknown";
}

async function runClaude({ claudeBin, dir, sessionId, prompt, append }) {
  const runDir = path.join(dir, ".run");
  const streamPath = path.join(runDir, "stream.jsonl");
  const errPath = path.join(runDir, "stderr.txt");
  const out = fs.createWriteStream(streamPath, { flags: "w" });
  const err = fs.createWriteStream(errPath, { flags: "w" });
  const { args, format } = buildClaudeArgs({
    claudeBin,
    mcpPath: path.join(runDir, "mcp.json"),
    sessionId,
    prompt,
    append,
  });
  fs.writeFileSync(path.join(runDir, "claude-argv.json"), `${JSON.stringify({ format, args: args.filter((a) => a !== prompt && a !== append) }, null, 2)}\n`);
  const started = Date.now();
  info(`claude --print (${format}) em ${dir}`);
  const child = spawn(claudeBin, args, {
    cwd: dir,
    env: {
      ...process.env,
      DISABLE_AUTOUPDATER: "1",
      MCP_TIMEOUT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let turns = 0;
  let last = "";
  let buf = "";
  child.stdout.on("data", (chunk) => {
    out.write(chunk);
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === "assistant") turns += 1;
        const content = o.message?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "tool_use") last = c.name;
          }
        }
      } catch {
        /* json envelope is one blob; parsed after exit */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    err.write(chunk);
  });
  const tick = setInterval(() => {
    const min = Math.round((Date.now() - started) / 60000);
    process.stderr.write(`  … ${path.basename(dir)}  ~${min} min  turnos≈${turns}  ${last}\n`);
  }, 30_000);
  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c ?? 1));
  });
  clearInterval(tick);
  await new Promise((r) => out.end(r));
  await new Promise((r) => err.end(r));
  const observedWallMs = Date.now() - started;
  const result = extractResult(streamPath);
  if (result) {
    const summary = {
      session_id: result.session_id,
      is_error: result.is_error,
      stop_reason: result.stop_reason,
      num_turns: result.num_turns,
      duration_ms: result.duration_ms,
      duration_api_ms: result.duration_api_ms,
      total_cost_usd: result.total_cost_usd,
      usage: result.usage,
      modelUsage: result.modelUsage,
      extra: result.extra,
      permission_denials: denialsOf(result),
      observed_wall_ms: observedWallMs,
      exit_code: code,
    };
    fs.writeFileSync(path.join(runDir, "result-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return { code, result, observedWallMs, streamPath };
}

function probeClaudeAuth(claudeBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tetris-ab-auth-"));
  spawnSync(resolveBin("git") || "git", ["init"], { cwd: tmp, encoding: "utf8" });
  info("checando OAuth no modo --print (é o que os braços usam)");
  const r = spawnSync(
    claudeBin,
    ["--print", "--output-format", "json", "--", "Reply with the single word: ok"],
    {
      cwd: tmp,
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  const blob = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (/OAuth session expired|Failed to authenticate|authentication_error|token has expired/i.test(blob)) {
    die(
      `Claude Code recusou --print: sessão OAuth expirada.\n${blob.trim().slice(0, 600)}\n\nNo Mac, num terminal interativo:\n  1. unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN\n  2. claude\n  3. /login  (completa no browser)\n  4. saia e prove:  claude --print --output-format json -- "ok"\nSó depois rode de novo o A/B.`
    );
  }
}

function probeClaudePermissions(claudeBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tetris-ab-perm-"));
  spawnSync(resolveBin("git") || "git", ["init"], { cwd: tmp, encoding: "utf8" });
  const sid = crypto.randomUUID();
  writeHarness(tmp, "treatment", "probe", "probe", sid);
  info("checando --allowed-tools no --print (sem --dangerously-skip-permissions)");
  const mcpPath = path.join(tmp, ".run", "mcp.json");
  const prompt =
    "Call mcp__local-coder__status exactly once. Then call Bash exactly once with command echo PERM_OK. Reply with the single token PERM_OK if both tools ran. If a tool is denied, reply DENIED and the tool name. Do not ask the user to approve anything.";
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    process.env.TETRIS_AB_PROBE_MODEL || "haiku",
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
    ...permissionFlags(),
    "--",
    prompt,
  ];
  if (args.includes("--dangerously-skip-permissions")) {
    die("probe recusou argv com --dangerously-skip-permissions");
  }
  const r = spawnSync(claudeBin, args, {
    cwd: tmp,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    maxBuffer: 4 * 1024 * 1024,
  });
  const blob = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (/unknown option.*dangerously-skip|bypassPermissions.*disabled|disableBypassPermissionsMode/i.test(blob)) {
    die(
      `Claude recusou um modo de bypass. Este harness não envia --dangerously-skip-permissions.\n${blob.trim().slice(0, 600)}`
    );
  }
  if (/OAuth session expired|Failed to authenticate|authentication_error|token has expired/i.test(blob)) {
    die(`probe de permissão: OAuth recusou --print.\n${blob.trim().slice(0, 600)}`);
  }
  if (/model.*not found|unknown model|invalid model/i.test(blob) && /haiku/i.test(args.join(" "))) {
    info("haiku indisponível no probe; tentando o modelo default");
    const i = args.indexOf("--model");
    if (i >= 0) args.splice(i, 2);
    const r2 = spawnSync(claudeBin, args, {
      cwd: tmp,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
      maxBuffer: 4 * 1024 * 1024,
    });
    return finishPermProbe(`${r2.stdout || ""}\n${r2.stderr || ""}`);
  }
  finishPermProbe(blob);
}

function finishPermProbe(blob) {
  const result = extractFromText(blob);
  const denials = denialsOf(result);
  const text = String(result?.result || blob);
  if (denials.length > 0) {
    const names = [...new Set(denials.map((d) => d.tool_name).filter(Boolean))];
    die(
      `Ferramentas ainda negadas no --print — é a falha do Mac 042623Z.\nEste Mac de empresa não usa --dangerously-skip-permissions. O harness pré-aprova via --allowed-tools + --permission-mode ${PERMISSION_MODE} (igual B12).\npermission_denials=${denials.length} (${names.join(", ")})\n${text.slice(0, 600)}\nSe o managed settings bloquear até o allowlist, o A/B não roda neste CLI.`
    );
  }
  if (/\bDENIED\b/.test(text) || !/PERM_OK/.test(text)) {
    die(
      `probe de permissão não obteve PERM_OK (Bash + mcp__local-coder__status).\n${text.slice(0, 800)}\nNão inicie o A/B: o 30B seria o mesmo abort do 042623Z.`
    );
  }
  info("probe de permissão ok (--allowed-tools, sem skip-permissions)");
}

async function confirm(rl, lines) {
  if (envFlag("TETRIS_AB_YES")) return;
  if (!process.stdin.isTTY) die("sem TTY: exporte TETRIS_AB_YES=1 para seguir");
  console.error("");
  for (const line of lines) console.error(line);
  const ans = await askLine(rl, "Continuar? [y/N] ");
  if (!/^y(es)?$/i.test(ans)) {
    console.error("abortado.");
    process.exit(0);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Uso: bash scripts/tetris-ab-mac.sh

Antes dos braços, o script lista os modelos do LM Studio e pede qual usar.
Os dois braços usam o mesmo prompt de Tetris (24/08/2026), --model opus,
--strict-mcp-config. Controle: MCP vazio. Tratamento: local-coder + o modelo escolhido.

  --demo-table     imprime a tabela do laptop-01 sem gastar API
  --preflight      Node, npm, build, claude, LM Studio e probe de permissão
                   (--allowed-tools; NÃO usa --dangerously-skip-permissions)
  TETRIS_AB_MODEL  id do modelo (pula o menu)
  TETRIS_AB_YES=1  não pede confirmação
  CLAUDE_BIN       caminho do claude
  TETRIS_AB_STREAM_JSON=1  usa stream-json+verbose (laptop); default é json
  TETRIS_AB_PERMISSION_MODE  default acceptEdits (B12). bypass/skip recusados
`);
    return;
  }
  if (argv.includes("--demo-table")) {
    parserSelfCheck();
    console.log(renderTable(DEMO_CONTROL, DEMO_TREATMENT));
    return;
  }
  if (process.platform !== "darwin" && !envFlag("TETRIS_AB_ALLOW_NON_DARWIN")) {
    die("este harness é o teste do Mac. No outro SO: TETRIS_AB_ALLOW_NON_DARWIN=1");
  }

  requireNode22();
  parserSelfCheck();
  ensureBuilt();
  await verifyBuiltArtifacts();
  const claudeBin = findClaude();
  if (!claudeBin) {
    die(
      "claude CLI não encontrado no PATH. No Mac B12 ele costuma estar em ~/.local/bin/claude ou ~/.local/share/claude/versions/<ver>. Defina CLAUDE_BIN se preciso."
    );
  }
  const version = claudeVersion(claudeBin);
  const caps = inspectClaude(claudeBin);
  info(`claude: ${claudeBin}`);
  info(`versão: ${version}`);
  info(`flags: output=json allowed-tools + permission-mode=${PERMISSION_MODE} (sem skip-permissions)`);
  if (!caps.allowedTools) {
    info("claude --help não listou --allowed-tools; passando mesmo assim (é o que o B12 usa neste Mac)");
  }
  info(`commit: ${gitHead()}`);
  info(`node: v${process.versions.node}`);

  await ensureLmsUp();
  probeClaudeAuth(claudeBin);
  probeClaudePermissions(claudeBin);
  if (argv.includes("--preflight")) {
    const models = await collectModels();
    if (models.length === 0) {
      die("preflight: LM Studio responde, mas nenhum modelo na lista. Baixe um no app (Developer > lms ls).");
    }
    const authHint = ["/.claude.json", "/.config/claude", "/.claude"]
      .map((rel) => path.join(os.homedir(), rel.replace(/^\//, "")))
      .some((p) => fs.existsSync(p));
    console.log("preflight ok");
    console.log(`  node     v${process.versions.node}`);
    console.log(`  claude   ${version}`);
    console.log("  output   json  (stream-json só com TETRIS_AB_STREAM_JSON=1)");
    console.log("  perms    --allowed-tools + acceptEdits (B12; sem skip-permissions)");
    console.log(`  commit   ${gitHead()}`);
    console.log(`  undici   ok`);
    console.log(`  lms      ${LMS_URL}  (${models.length} modelo(s))`);
    if (!authHint) console.log("  aviso    não achei ~/.claude.json — confirme `claude` logado antes do teste");
    for (const m of models) {
      console.log(`            ${m.loaded ? "*" : " "} ${m.id}`);
    }
    console.log("rode de novo sem --preflight para gastar os dois braços Opus.");
    return;
  }
  const models = await collectModels();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const picked = await pickModel(rl, models);
  const already = models.find((m) => m.id.toLowerCase() === picked.toLowerCase())?.loaded;
  if (!already) {
    loadModel(picked);
    await waitServed(picked);
  }
  const { servedId, quality } = await resolveServedId(picked);
  info(`modelo escolhido: ${picked}`);
  info(`id servido em /v1/models: ${servedId} (match ${quality})`);

  const prompt = userPromptFor(servedId);
  const parent = process.env.TETRIS_AB_PARENT
    ? path.resolve(process.env.TETRIS_AB_PARENT)
    : path.dirname(REPO);
  const stamp = stampNow();
  const controlDir = path.join(parent, `tetris-ab-opus-only-${stamp}`);
  const treatDir = path.join(parent, `tetris-ab-opus-local-${stamp}`);
  const outDir = path.join(parent, `tetris-ab-results-${stamp}`);
  for (const d of [controlDir, treatDir, outDir]) {
    if (fs.existsSync(d)) die(`já existe ${d}`);
  }

  await confirm(rl, [
    "Dois braços Opus, na ordem do laptop-01:",
    `  1. Opus só          → ${controlDir}`,
    `  2. Opus + local-coder (${servedId}) → ${treatDir}`,
    "No laptop isso foi ~USD 4,36 + ~USD 4,98 e o 2º braço levou ~2 h.",
    "No Mac o wall do tratamento tende a cair se o local for rápido; a cota Opus não.",
    `Timeout local: ${TIMEOUT_MS} ms. Contexto: ${CONTEXT_LENGTH}.`,
    `Resultados: ${outDir}`,
  ]);
  rl.close();

  fs.mkdirSync(controlDir);
  fs.mkdirSync(treatDir);
  fs.mkdirSync(outDir);
  for (const d of [controlDir, treatDir]) {
    const g = spawnSync(resolveBin("git") || "git", ["init"], { cwd: d, encoding: "utf8" });
    if (g.status !== 0) info(`git init em ${d} falhou (${g.stderr.trim() || g.status})`);
  }
  const controlSid = crypto.randomUUID();
  const treatSid = crypto.randomUUID();
  writeHarness(controlDir, "control", prompt, controlAppend(), controlSid);
  writeHarness(treatDir, "treatment", prompt, treatmentAppend(servedId), treatSid);

  const meta = {
    stamp,
    repo: REPO,
    git_head: gitHead(),
    claude_bin: claudeBin,
    claude_version: version,
    picked_model: picked,
    served_id: servedId,
    match_quality: quality,
    context_length: CONTEXT_LENGTH,
    local_coder_timeout_ms: TIMEOUT_MS,
    lms_url: LMS_URL,
    prompt,
    control_dir: controlDir,
    treatment_dir: treatDir,
    control_session_id: controlSid,
    treatment_session_id: treatSid,
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  info("braço 1/2 — Opus só");
  const controlRun = await runClaude({
    claudeBin,
    dir: controlDir,
    sessionId: controlSid,
    prompt,
    append: controlAppend(),
  });
  const controlFailed = armFailed(controlRun);
  if (controlFailed && !envFlag("TETRIS_AB_CONTINUE_ON_ERROR")) {
    const testsC = countTests(controlDir);
    const table = renderTable(
      armRow(controlRun.result, testsC, controlRun.observedWallMs),
      armRow(null, { label: "não rodou" }, null)
    );
    fs.writeFileSync(path.join(outDir, "table.md"), `${table}\n`);
    console.log(table);
    const fail = claudeFailureText(controlDir, controlRun.result, controlRun.code);
    const why = fail.weekly
      ? "controle recusou com limite semanal / 429. Tratamento não iniciado."
      : fail.denials
        ? "controle bloqueado por permissão (mesmo modo do 042623Z). Tratamento não iniciado."
        : "controle caiu antes de trabalho equivalente (não foi cota). Tratamento não iniciado.";
    die(`${why}\n${fail.text}\nTETRIS_AB_CONTINUE_ON_ERROR=1 para forçar o 2º braço.`);
  }

  info("braço 2/2 — Opus + local-coder");
  const treatRun = await runClaude({
    claudeBin,
    dir: treatDir,
    sessionId: treatSid,
    prompt,
    append: treatmentAppend(servedId),
  });

  info("rodando as suítes de cada worktree");
  const testsC = countTests(controlDir);
  const testsT = countTests(treatDir);
  const controlRow = armRow(controlRun.result, testsC, controlRun.observedWallMs);
  const treatRow = armRow(treatRun.result, testsT, treatRun.observedWallMs);
  const table = renderTable(controlRow, treatRow);
  fs.writeFileSync(path.join(outDir, "table.md"), `${table}\n`);
  fs.writeFileSync(
    path.join(outDir, "table.json"),
    `${JSON.stringify({ control: controlRow, treatment: treatRow, tests: { control: testsC.parsed, treatment: testsT.parsed } }, null, 2)}\n`
  );
  meta.finished_at = new Date().toISOString();
  meta.control_cost_usd = controlRun.result?.total_cost_usd ?? null;
  meta.treatment_cost_usd = treatRun.result?.total_cost_usd ?? null;
  fs.writeFileSync(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  console.log("");
  console.log(table);
  console.log("");
  console.error(`tabela também em ${path.join(outDir, "table.md")}`);
  if (treatRun.result?.extra) {
    console.error(
      `tratamento: timeouts=${treatRun.result.extra.timeouts} malformed=${treatRun.result.extra.malformed}`
    );
  }
  if (hasDenials(treatRun.result)) {
    console.error(
      `tratamento: permission_denials=${denialsOf(treatRun.result).length} — o 30B não rodou`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
