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

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
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

function findClaude() {
  if (process.env.CLAUDE_BIN) {
    if (!fs.existsSync(process.env.CLAUDE_BIN)) {
      die(`CLAUDE_BIN não existe: ${process.env.CLAUDE_BIN}`);
    }
    return process.env.CLAUDE_BIN;
  }
  const fromPath = runCapture("bash", ["-lc", "command -v claude"]);
  const p = fromPath.stdout.trim();
  if (p && fs.existsSync(p)) return p;
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
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(local)) return local;
  return null;
}

function claudeVersion(bin) {
  const r = runCapture(bin, ["--version"], { timeout: 15000 });
  return (r.stdout || r.stderr).trim().split(/\n/)[0] || "unknown";
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

function listLmsDownloaded() {
  const r = runCapture("lms", ["ls", "--json"]);
  if (r.status !== 0) return [];
  const parsed = parseJsonLoose(r.stdout);
  if (parsed === null) return [];
  const ids = [];
  for (const row of rowsOf(parsed)) {
    for (const id of idsOfRow(row)) ids.push(id);
  }
  return ids;
}

function listLmsLoaded() {
  const r = runCapture("lms", ["ps", "--json"]);
  if (r.status !== 0) return [];
  const parsed = parseJsonLoose(r.stdout);
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

function extractResult(streamPath) {
  if (!fs.existsSync(streamPath)) return null;
  const lines = fs.readFileSync(streamPath, "utf8").split(/\n/).filter(Boolean);
  let result = null;
  const tools = {};
  let timeouts = 0;
  let malformed = 0;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "result") result = o;
    const content = o.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_use") {
          tools[c.name] = (tools[c.name] || 0) + 1;
        }
      }
    }
    if (o.type === "user") {
      const blob = JSON.stringify(o);
      if (blob.includes("llm_timeout")) timeouts += 1;
      if (blob.includes("model_output_malformed")) malformed += 1;
    }
  }
  return result ? { ...result, extra: { tools, timeouts, malformed } } : null;
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

function ensureBuilt() {
  const server = path.join(REPO, "dist", "server.js");
  const selection = path.join(REPO, "dist", "selection.js");
  const needCi = !fs.existsSync(path.join(REPO, "node_modules", "undici"));
  if (needCi) {
    info("npm ci --ignore-scripts");
    const r = spawnSync("npm", ["ci", "--ignore-scripts"], {
      cwd: REPO,
      stdio: "inherit",
      env: process.env,
    });
    if (r.status !== 0) die("npm ci falhou");
  }
  if (!fs.existsSync(server) || !fs.existsSync(selection) || envFlag("TETRIS_AB_REBUILD")) {
    info("npm run build");
    const r = spawnSync("npm", ["run", "build"], {
      cwd: REPO,
      stdio: "inherit",
      env: process.env,
    });
    if (r.status !== 0) die("npm run build falhou");
  }
  if (!fs.existsSync(server)) die("dist/server.js ausente depois do build");
}

async function ensureLmsUp() {
  let ids = await fetchServedIds();
  if (ids !== null) return;
  info("tentando `lms server start`");
  runCapture("lms", ["server", "start"], { timeout: 30_000 });
  for (let i = 0; i < 20; i++) {
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
  for (let i = 0; i < 60; i++) {
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
  die(`timeout esperando ${id} aparecer em /v1/models`);
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
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "opus",
    "--strict-mcp-config",
    "--mcp-config",
    path.join(runDir, "mcp.json"),
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--session-id",
    sessionId,
    "--append-system-prompt",
    append,
    "--",
    prompt,
  ];
  const started = Date.now();
  info(`claude --print em ${dir}`);
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
        /* stream noise */
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
      observed_wall_ms: observedWallMs,
      exit_code: code,
    };
    fs.writeFileSync(path.join(runDir, "result-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
  return { code, result, observedWallMs, streamPath };
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
  TETRIS_AB_MODEL  id do modelo (pula o menu)
  TETRIS_AB_YES=1  não pede confirmação
  CLAUDE_BIN       caminho do claude
`);
    return;
  }
  if (argv.includes("--demo-table")) {
    console.log(renderTable(DEMO_CONTROL, DEMO_TREATMENT));
    return;
  }
  if (process.platform !== "darwin" && !envFlag("TETRIS_AB_ALLOW_NON_DARWIN")) {
    die("este harness é o teste do Mac. No outro SO: TETRIS_AB_ALLOW_NON_DARWIN=1");
  }

  ensureBuilt();
  const claudeBin = findClaude();
  if (!claudeBin) die("claude CLI não encontrado. Instale o Claude Code ou defina CLAUDE_BIN.");
  const version = claudeVersion(claudeBin);
  info(`claude: ${claudeBin}`);
  info(`versão: ${version}`);
  info(`commit: ${gitHead()}`);

  await ensureLmsUp();
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
  if (controlRun.result?.is_error && !envFlag("TETRIS_AB_CONTINUE_ON_ERROR")) {
    const testsC = countTests(controlDir);
    const table = renderTable(
      armRow(controlRun.result, testsC, controlRun.observedWallMs),
      armRow(null, { label: "não rodou" }, null)
    );
    fs.writeFileSync(path.join(outDir, "table.md"), `${table}\n`);
    console.log(table);
    die("controle terminou com erro (limite semanal?). Tratamento não iniciado. TETRIS_AB_CONTINUE_ON_ERROR=1 para forçar.");
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
