#!/usr/bin/env node
/**
 * Set the MCP server's own environment, which is the only place that works.
 *
 * This exists because the same mistake has now cost two runs. The server does
 * NOT inherit the shell that launched Claude Code — its environment comes from
 * the `env` block of its entry in `~/.claude.json`. `run 2026-08-04-mac-07`
 * exported LOCAL_CODER_TIMEOUT_MS=60000 into the setup shell, the server used
 * 20000, and only the analyzer refusing to score against the shell value kept
 * that run from returning a confident wrong verdict. A later attempt to edit
 * the file by hand was silently reverted, because Claude Code rewrites
 * ~/.claude.json when it exits and had been left open.
 *
 * So: close Claude Code, run this, reopen it, and confirm through the SERVER
 * rather than the file — `status` reports what the process actually loaded.
 *
 *   node scripts/set-server-env.mjs show
 *   node scripts/set-server-env.mjs set LOCAL_CODER_TIMEOUT_MS=600000
 *   node scripts/set-server-env.mjs unset LOCAL_CODER_MAX_OUTPUT_TOKENS
 *
 * Options: --server=<name> (default local-coder), --config=<path>.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flags = new Map(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)];
  })
);
const positional = argv.filter((a) => !a.startsWith("--"));
const command = positional[0];
const rest = positional.slice(1);

const SERVER = flags.get("server") ?? "local-coder";
const CONFIG = flags.get("config") ?? path.join(os.homedir(), ".claude.json");

const die = (message) => {
  console.error(message);
  process.exit(1);
};

/**
 * Servers can sit at the top level or under `projects[<path>].mcpServers`, and
 * a machine can have both. Every match is returned rather than the first:
 * updating one of two and reporting success is how a change looks applied and
 * is not.
 */
function findServers(config) {
  const found = [];
  const visit = (node, where) => {
    if (node === null || typeof node !== "object") return;
    const server = node.mcpServers?.[SERVER];
    if (server !== undefined) found.push({ server, where });
    for (const [key, value] of Object.entries(node)) {
      if (key === "mcpServers") continue;
      visit(value, where === "" ? key : `${where}.${key}`);
    }
  };
  visit(config, "");
  return found;
}

function load() {
  let raw;
  try {
    raw = readFileSync(CONFIG, "utf8");
  } catch (error) {
    die(`cannot read ${CONFIG}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${CONFIG} is not valid JSON (${error instanceof Error ? error.message : String(error)}); nothing was written`);
  }
}

function show() {
  const found = findServers(load());
  if (found.length === 0) die(`no MCP server named ${JSON.stringify(SERVER)} in ${CONFIG}`);
  for (const { server, where } of found) {
    console.log(`${SERVER} @ ${where === "" ? "<root>" : where}`);
    const env = server.env ?? {};
    const keys = Object.keys(env).sort();
    if (keys.length === 0) console.log("  (no env block)");
    for (const key of keys) console.log(`  ${key}=${env[key]}`);
  }
}

function mutate(apply, describe) {
  const config = load();
  const found = findServers(config);
  if (found.length === 0) die(`no MCP server named ${JSON.stringify(SERVER)} in ${CONFIG}; nothing was written`);

  const backup = `${CONFIG}.bak`;
  copyFileSync(CONFIG, backup);
  for (const { server } of found) {
    server.env = server.env ?? {};
    apply(server.env);
  }
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

  // Re-read rather than trust the write. A redirect that never opened the file
  // leaves the old bytes in place, and every check that inspects the in-memory
  // object would happily approve them.
  const after = findServers(load());
  const ok = after.every(({ server }) => describe.every(([k, v]) => (server.env ?? {})[k] === v));
  if (!ok) die(`the file does not read back with the intended values; restore with: cp ${backup} ${CONFIG}`);

  console.log(`updated ${found.length} entr${found.length === 1 ? "y" : "ies"} in ${CONFIG}`);
  console.log(`backup: ${backup}`);
  for (const [k, v] of describe) console.log(`  ${k}=${v === undefined ? "(removed)" : v}`);
  console.log("");
  console.log("The file is only half of it. The running server loaded its env at startup,");
  console.log("so RESTART Claude Code, then confirm through the server and not the file:");
  console.log("");
  console.log(`    Call the ${SERVER} status tool and report its configured limits.`);
  console.log("");
  console.log("If the file was edited while Claude Code was open, it rewrites ~/.claude.json");
  console.log("on exit and the change is gone. Close it first, then re-run this.");
}

if (command === "show") {
  show();
} else if (command === "set") {
  if (rest.length === 0) die("usage: set KEY=VALUE [KEY=VALUE ...]");
  const pairs = rest.map((entry) => {
    const i = entry.indexOf("=");
    if (i <= 0) die(`not a KEY=VALUE pair: ${JSON.stringify(entry)}`);
    // Values are strings on purpose: this is an environment block, and a JSON
    // number here reaches the server as something its env parser never sees.
    return [entry.slice(0, i), entry.slice(i + 1)];
  });
  mutate((env) => {
    for (const [k, v] of pairs) env[k] = v;
  }, pairs);
} else if (command === "unset") {
  if (rest.length === 0) die("usage: unset KEY [KEY ...]");
  mutate(
    (env) => {
      for (const k of rest) delete env[k];
    },
    rest.map((k) => [k, undefined])
  );
} else {
  console.error("usage: set-server-env.mjs {show|set KEY=VALUE...|unset KEY...} [--server=name] [--config=path]");
  process.exit(1);
}
