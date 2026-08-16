/**
 * The pre-commit pin guard, tested for an INVERTED verdict.
 *
 * `b12-firing.mjs` states the reason and it applies here unchanged: a verdict
 * that can only be exercised by running the real thing cannot be tested for
 * being backwards, and a pin check that is backwards certifies a stale pin —
 * which is the exact failure this guard exists to prevent.
 *
 * The integration cases are the ones that matter, because they are what
 * `tests/b12-plan.test.ts` cannot see: a repository whose HEAD is clean and
 * whose staged tree carries a changed harness with an unchanged pin. That is
 * every pre-commit moment of every commit touching a pinned path.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GitUnaskable,
  INDEX_PINS,
  pinMismatches,
  readTreeConfig,
  readTreeSubjects,
  sha256,
  writeTree,
} from "../scripts/b12-pins-check.mjs";
import { makeTempRoot } from "./helpers.js";

const RUN = "scripts/b12-run.mjs";
const MD = "CLAUDE.md";
const GUARD = path.resolve(import.meta.dirname, "..", "scripts", "b12-pins-check.mjs");

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Every read the guard takes, against one frozen tree. */
const verdict = (root: string) => {
  const tree = writeTree(root);
  return pinMismatches(readTreeSubjects(root, tree), readTreeConfig(root, tree).pinned);
};

/** A repository whose HEAD is self-consistent. */
const seed = (): string => {
  const root = makeTempRoot("b12-pins-");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "b12-corpus"), { recursive: true });
  fs.writeFileSync(path.join(root, RUN), "// harness v1\n");
  fs.writeFileSync(path.join(root, MD), "# rules v1\n");
  const pinned = {
    b12RunSha256: sha256(fs.readFileSync(path.join(root, RUN))),
    claudeMdSha256: sha256(fs.readFileSync(path.join(root, MD))),
  };
  fs.writeFileSync(path.join(root, "b12-corpus/manifest-config.json"), JSON.stringify({ pinned }, null, 2));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
  return root;
};

describe("b12-pins-check — the pure verdict", () => {
  it("covers exactly the two pins the CI alarm compares against HEAD", () => {
    // ratesSha256 is compared at plan.parent, a FIXED commit, so no commit made
    // here can move it. Including it would only add a way to be wrong.
    expect(INDEX_PINS.map((p) => p.pin).sort()).toEqual(["b12RunSha256", "claudeMdSha256"]);
    expect(INDEX_PINS.map((p) => p.subject).sort()).toEqual([MD, RUN]);
  });

  it("stays silent when both pins name the staged bytes", () => {
    const measured = { [RUN]: "a".repeat(64), [MD]: "b".repeat(64) };
    expect(pinMismatches(measured, { b12RunSha256: "a".repeat(64), claudeMdSha256: "b".repeat(64) })).toEqual([]);
  });

  it("FIRES on the stale pin, and names which one", () => {
    const bad = pinMismatches(
      { [RUN]: "a".repeat(64), [MD]: "b".repeat(64) },
      { b12RunSha256: "c".repeat(64), claudeMdSha256: "b".repeat(64) }
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
    expect(bad[0]!.declared).toBe("c".repeat(64));
    expect(bad[0]!.measured).toBe("a".repeat(64));
  });

  it("treats an ABSENT pin as a mismatch, never as a skip", () => {
    // b12-run.mjs:1066 checks presence only, so an absent pin already passes
    // every other check in the toolchain.
    const bad = pinMismatches({ [RUN]: "a".repeat(64), [MD]: "b".repeat(64) }, { claudeMdSha256: "b".repeat(64) });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
    expect(bad[0]!.declared).toBeNull();
  });

  it("treats a path missing from the tree as a mismatch too", () => {
    const bad = pinMismatches({ [MD]: "b".repeat(64) }, { b12RunSha256: "a".repeat(64), claudeMdSha256: "b".repeat(64) });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.subject).toBe(RUN);
    expect(bad[0]!.measured).toBeNull();
  });

  it("REFUSES a symlink or gitlink instead of hashing the wrong object", () => {
    const bad = pinMismatches(
      { [RUN]: { mode: "120000", type: "blob" }, [MD]: "b".repeat(64) },
      { b12RunSha256: "a".repeat(64), claudeMdSha256: "b".repeat(64) }
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]!.why).toMatch(/not a regular file \(120000 blob\)/);
  });

  it("does not throw when the config's pinned block is missing or not an object", () => {
    const measured = { [RUN]: "a".repeat(64), [MD]: "b".repeat(64) };
    expect(pinMismatches(measured, undefined)).toHaveLength(2);
    expect(pinMismatches(measured, "nonsense")).toHaveLength(2);
    // A non-string pin renders rather than crashing the message.
    expect(pinMismatches(measured, { b12RunSha256: 7, claudeMdSha256: "b".repeat(64) })[0]!.declared).toBe("7");
  });
});

describe("b12-pins-check — against a real tree", () => {
  it("passes when the staged tree is self-consistent", () => {
    expect(verdict(seed())).toEqual([]);
  });

  it("CATCHES THE CASE THE HEAD-READING ALARM CANNOT: harness staged, pin not re-pinned", () => {
    const root = seed();
    fs.writeFileSync(path.join(root, RUN), "// harness v2 — edited\n");
    git(root, ["add", RUN]);

    // The alarm's reading. HEAD still carries v1 and the v1 pin, so it is GREEN
    // — which is why a stale pin survives every local gate and only goes red in
    // CI, after the commit exists.
    const atHead = sha256(execFileSync("git", ["show", `HEAD:${RUN}`], { cwd: root, maxBuffer: 1 << 26 }));
    const tree = writeTree(root);
    const pinned = readTreeConfig(root, tree).pinned as Record<string, string>;
    expect(pinned.b12RunSha256).toBe(atHead);

    const bad = verdict(root);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
  });

  it("refuses a PARTIAL staging — config re-pinned but not staged", () => {
    // Both sides come from the tree for this reason. Re-pinning in the working
    // tree and forgetting to stage it is the same stale commit wearing a clean
    // working tree, and reading the config off disk would call it green.
    const root = seed();
    fs.writeFileSync(path.join(root, RUN), "// harness v2 — edited\n");
    git(root, ["add", RUN]);
    const cfgPath = path.join(root, "b12-corpus/manifest-config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.pinned.b12RunSha256 = sha256(fs.readFileSync(path.join(root, RUN)));
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    expect(verdict(root)).toHaveLength(1);

    git(root, ["add", "b12-corpus/manifest-config.json"]);
    expect(verdict(root)).toEqual([]);
  });

  it("throws GitUnaskable rather than reporting a verdict, when git cannot answer", () => {
    // The distinction the two exit codes exist for. The first draft caught every
    // git failure per path and folded it into "no such path", so an unreadable
    // object came back as a STALE PIN — a verdict, about a pin, from a failure
    // that said nothing about one.
    const notARepo = makeTempRoot("b12-pins-norepo-");
    expect(() => writeTree(notARepo)).toThrow(GitUnaskable);
  });
});

describe("b12-pins-check — the CLI's exit codes", () => {
  const run = (repo: string) => spawnSync(process.execPath, [GUARD, repo], { encoding: "utf8" });

  it("exits 0 and names the tree when the pins hold", () => {
    const r = run(seed());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 KNOWN-HERE pin\(s\) name the staged bytes/);
    expect(r.stdout).toMatch(/staged tree: [0-9a-f]{40}/);
  });

  it("exits 1 — a verdict — on a stale pin", () => {
    const root = seed();
    fs.writeFileSync(path.join(root, RUN), "// harness v2 — edited\n");
    git(root, ["add", RUN]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING/);
    expect(r.stderr).toMatch(/pinned\.b12RunSha256/);
  });

  it("exits 2 — operational, NOT a verdict — when the tree cannot be read", () => {
    const r = run(makeTempRoot("b12-pins-norepo-"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/could not be read/);
    expect(r.stderr).not.toMatch(/REFUSING/);
  });
});
