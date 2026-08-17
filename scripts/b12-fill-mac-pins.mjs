/**
 * b12-fill-mac-pins.mjs — fill the Mac-only pins into b12-corpus/manifest-config.json.
 *
 *   node scripts/b12-fill-mac-pins.mjs      (from the clone root, on the Mac)
 *
 * Env:
 *   B12_POLICY_REPO    required — the ~/b12-policy clone (full, not shallow)
 *   B12_POLICY_COMMIT  required — full 40-hex commit the blobs are sealed at
 *   B12_PILOT_DATE     optional — YYYY-MM-DD; default is today's UTC date
 *   B12_PROBE          optional — evidence/<...>.probe.json to pin; default is
 *                      the lexicographically last committed installedchars
 *                      probe (names begin with their UTC timestamp)
 *
 * Fills exactly seven leaves: pilotRunId, pinned.installedCharsProbe(+Sha256),
 * pinned.policyBlobs.{treatment,control}, pinned.captureSha256 — and REFUSES
 * rather than writing if anything else would change.
 *
 * WHY THE PARANOIA. This file is committed on a machine that cannot push; the
 * bytes come home and are committed verbatim. A stray change smuggled into the
 * same write would be invisible until diff-review at reconciliation — after
 * the paid sessions ran under it. So: the file must round-trip byte-identically
 * BEFORE the edit (runToolchain was pre-formatted on Windows to make that
 * true), the edit is applied to the parsed object, and the old and new trees
 * are deep-compared with an explicit allowlist of paths that may differ.
 *
 * IT ALSO CROSS-CHECKS THE CALIBRATION KEY EARLY: the probe it pins must have
 * been taken under the mcp-config bytes and policy blobs it sits beside in the
 * same manifest, or observe will refuse at spend time. Checking here turns a
 * wrong-probe pick into a free refusal with the mismatching component named.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const CONFIG = path.join(REPO, "b12-corpus", "manifest-config.json");

const refuse = (msg) => {
  console.error(`fill-mac-pins: REFUSED — ${msg}`);
  process.exit(2);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, args, opts = {}) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...opts });

// --- the config must round-trip before we touch it -------------------------
if (!existsSync(CONFIG)) refuse(`${CONFIG} does not exist — run from the clone root`);
const rawBefore = readFileSync(CONFIG, "utf8");
let cfg;
try {
  cfg = JSON.parse(rawBefore);
} catch (e) {
  refuse(`manifest-config.json is not valid JSON: ${e.message}`);
}
if (rawBefore !== JSON.stringify(cfg, null, 2) + "\n") {
  refuse(
    "manifest-config.json does not round-trip byte-identically through JSON.stringify(,2) — " +
      "the Windows pre-format step (runToolchain expanded multi-line) is missing or something " +
      "else reformatted the file. Do not edit by other means; fix the formatting first."
  );
}
const cfgBefore = JSON.parse(rawBefore); // independent copy for the post-diff

// --- policy repo and commit ------------------------------------------------
const policyRepo = process.env.B12_POLICY_REPO || "";
const policyCommit = process.env.B12_POLICY_COMMIT || "";
if (!policyRepo) refuse("B12_POLICY_REPO is not set — the ~/b12-policy clone");
if (!/^[0-9a-f]{40}$/.test(policyCommit)) refuse(`B12_POLICY_COMMIT must be full 40-hex (got "${policyCommit}")`);
if (!existsSync(policyRepo)) refuse(`B12_POLICY_REPO ${policyRepo} does not exist`);

// The pin says "../b12-policy" so that every checkout resolves its OWN
// sibling; the probe ran against B12_POLICY_REPO. If those are not the same
// physical directory, the manifest would name a repo the probe never touched.
const pinRepoRel = "../b12-policy";
const resolvedPin = spawnSync(
  process.execPath,
  ["-e", "process.stdout.write(require('fs').realpathSync(process.argv[1]))", path.resolve(REPO, pinRepoRel)],
  { encoding: "utf8" }
);
const resolvedEnv = spawnSync(
  process.execPath,
  ["-e", "process.stdout.write(require('fs').realpathSync(process.argv[1]))", policyRepo],
  { encoding: "utf8" }
);
if (resolvedPin.status !== 0) refuse(`${pinRepoRel} does not resolve from ${REPO} — clone the policy bundle beside the tree`);
if (resolvedEnv.status !== 0) refuse(`B12_POLICY_REPO ${policyRepo} does not resolve to a real path`);
if (resolvedPin.stdout !== resolvedEnv.stdout) {
  refuse(
    `the pin "${pinRepoRel}" resolves to ${resolvedPin.stdout} but B12_POLICY_REPO is ${resolvedEnv.stdout} — ` +
      "the manifest would name a repo the probe never touched. Clone the bundle at ~/b12-policy, beside ~/b12-tree."
  );
}
if (git(policyRepo, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
  refuse(`${policyRepo} is shallow or not a git repo — clone the full bundle`);
}
if (git(policyRepo, ["cat-file", "-e", `${policyCommit}^{commit}`]).status !== 0) {
  refuse(`commit ${policyCommit} is not present in ${policyRepo}`);
}

const blobShaAt = (blobPath) => {
  const shown = spawnSync("git", ["-C", policyRepo, "cat-file", "blob", `${policyCommit}:${blobPath}`], {
    maxBuffer: 1 << 28,
  });
  if (shown.status !== 0) {
    refuse(`${policyCommit.slice(0, 12)}:${blobPath} is not readable in ${policyRepo} — is the blob committed at that commit?`);
  }
  return sha256(shown.stdout ?? Buffer.alloc(0));
};
const treatmentSha = blobShaAt("treatment.md");
const controlSha = blobShaAt("control.md");

// --- the probe: committed, and calibrated against THESE components ---------
let probeRel = process.env.B12_PROBE || "";
if (!probeRel) {
  const candidates = readdirSync(path.join(REPO, "evidence"))
    .filter((n) => /installedchars.*\.probe\.json$/.test(n))
    .sort();
  if (candidates.length === 0) refuse("no evidence/*installedchars*.probe.json exists — run the M8 re-probe first");
  probeRel = `evidence/${candidates[candidates.length - 1]}`;
}
probeRel = probeRel.split(path.sep).join("/");

const runMod = await import(pathToFileURL(path.join(REPO, "scripts", "b12-run.mjs")).href);
const committed = runMod.committedEvidenceCheck(probeRel);
if (!committed.ok) refuse(`${probeRel}: ${committed.why} — commit the probe artifact before filling the pin`);
const probeBytes = readFileSync(committed.file);
const probeSha = sha256(probeBytes);
let probe;
try {
  probe = JSON.parse(probeBytes.toString("utf8"));
} catch {
  refuse(`${probeRel} is not JSON`);
}

const mcpPinned = cfg.pinned?.mcpConfig;
const mcpSha = cfg.pinned?.mcpConfigSha256;
if (!mcpPinned || !mcpSha) refuse("pinned.mcpConfig(+Sha256) is not filled — the Windows fill should have done that before the cut");
const mcpFile = path.isAbsolute(mcpPinned) ? mcpPinned : path.join(REPO, mcpPinned);
if (!existsSync(mcpFile)) refuse(`pinned.mcpConfig points at ${mcpFile}, which does not exist`);
const mcpLive = sha256(readFileSync(mcpFile));
if (mcpLive !== mcpSha) refuse(`pinned.mcpConfigSha256 ${mcpSha} != live ${mcpLive} — the committed config moved`);

const key = probe.context ?? {};
const mismatches = [];
if (key.mcpConfigSha256 !== mcpSha) mismatches.push(`mcpConfigSha256 (probe ${key.mcpConfigSha256}, manifest ${mcpSha})`);
if (key.policyBlobSha256s?.treatment !== treatmentSha) {
  mismatches.push(`policyBlobSha256s.treatment (probe ${key.policyBlobSha256s?.treatment}, sealed ${treatmentSha})`);
}
if (key.policyBlobSha256s?.control !== controlSha) {
  mismatches.push(`policyBlobSha256s.control (probe ${key.policyBlobSha256s?.control}, sealed ${controlSha})`);
}
if (cfg.pinned?.claudeBinarySha256 && key.claudeBinarySha256 !== cfg.pinned.claudeBinarySha256) {
  mismatches.push(`claudeBinarySha256 (probe ${key.claudeBinarySha256}, pinned ${cfg.pinned.claudeBinarySha256})`);
}
if (probe.sustained !== true) mismatches.push(`sustained is ${JSON.stringify(probe.sustained)} — an unsustained probe pins nothing`);
if (mismatches.length) {
  refuse(
    `${probeRel} was not taken under the components this manifest pins:\n  - ${mismatches.join("\n  - ")}\n` +
      "  Pick the right artifact with B12_PROBE, or re-run the M8 probe under B12_MCP_CONFIG and the policy env."
  );
}

// --- capture ---------------------------------------------------------------
const captureFile = path.join(REPO, "dist", "cost", "b12", "capture.js");
if (!existsSync(captureFile)) refuse(`${captureFile} is not built — npm run build first`);
const captureSha = sha256(readFileSync(captureFile));

// --- pilotRunId ------------------------------------------------------------
const date = process.env.B12_PILOT_DATE || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse(`B12_PILOT_DATE must be YYYY-MM-DD (got "${date}")`);
const pilotRunId = `${date}-mac-b12-pilot`;

// --- apply, then prove the write surface is exactly the intended one -------
cfg.pilotRunId = pilotRunId;
cfg.pinned.installedCharsProbe = probeRel;
cfg.pinned.installedCharsProbeSha256 = probeSha;
cfg.pinned.policyBlobs.treatment = { repo: pinRepoRel, commit: policyCommit, path: "treatment.md", sha256: treatmentSha };
cfg.pinned.policyBlobs.control = { repo: pinRepoRel, commit: policyCommit, path: "control.md", sha256: controlSha };
cfg.pinned.captureSha256 = captureSha;

const ALLOWED = new Set([
  "pilotRunId",
  "pinned.installedCharsProbe",
  "pinned.installedCharsProbeSha256",
  "pinned.policyBlobs.treatment",
  "pinned.policyBlobs.control",
  "pinned.captureSha256",
]);
const changed = [];
const diff = (a, b, at) => {
  if (ALLOWED.has(at)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(at);
    return;
  }
  const aObj = a !== null && typeof a === "object" && !Array.isArray(a);
  const bObj = b !== null && typeof b === "object" && !Array.isArray(b);
  if (aObj && bObj) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], at ? `${at}.${k}` : k);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(`FORBIDDEN:${at}`);
};
diff(cfgBefore, cfg, "");
const forbidden = changed.filter((c) => c.startsWith("FORBIDDEN:"));
if (forbidden.length) {
  refuse(`the edit would change paths outside the allowlist: ${forbidden.join(", ")} — nothing was written`);
}

writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8" });

console.log("fill-mac-pins: wrote b12-corpus/manifest-config.json");
console.log(`  pilotRunId                ${pilotRunId}`);
console.log(`  installedCharsProbe       ${probeRel}`);
console.log(`  installedCharsProbeSha256 ${probeSha}`);
console.log(`  policyBlobs.treatment     ${pinRepoRel}@${policyCommit.slice(0, 12)}:treatment.md ${treatmentSha.slice(0, 12)}…`);
console.log(`  policyBlobs.control       ${pinRepoRel}@${policyCommit.slice(0, 12)}:control.md ${controlSha.slice(0, 12)}…`);
console.log(`  captureSha256             ${captureSha}`);
console.log(`  changed paths             ${changed.filter((c) => !c.startsWith("FORBIDDEN:")).join(", ") || "(none?)"}`);
