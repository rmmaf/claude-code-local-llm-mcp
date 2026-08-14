/**
 * The pre-commit pin guard, tested for an INVERTED verdict.
 *
 * `b12-firing.mjs` states the reason and it applies here unchanged: a verdict
 * that can only be exercised by running the real thing cannot be tested for
 * being backwards, and a pin check that is backwards certifies a stale pin —
 * which is the exact failure this guard exists to prevent.
 *
 * The integration case at the bottom is the one that matters, because it is the
 * case `tests/b12-plan.test.ts` cannot see: a repository whose HEAD is clean and
 * whose INDEX carries a changed harness with an unchanged pin. That is every
 * pre-commit moment of every commit that touches a pinned path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INDEX_PINS, pinMismatches, readIndexConfig, readIndexSubjects, sha256 } from "../scripts/b12-pins-check.mjs";
import { makeTempRoot } from "./helpers.js";

const RUN = "scripts/b12-run.mjs";
const MD = "CLAUDE.md";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

describe("b12-pins-check — the pure verdict", () => {
  it("covers exactly the two pins the CI alarm compares against HEAD", () => {
    // ratesSha256 is compared at plan.parent, a FIXED commit, so no commit made
    // here can move it. Including it would only add a way to be wrong.
    expect(INDEX_PINS.map((p) => p.pin).sort()).toEqual(["b12RunSha256", "claudeMdSha256"]);
    expect(INDEX_PINS.map((p) => p.subject).sort()).toEqual([MD, RUN]);
  });

  it("stays silent when both pins name the staged bytes", () => {
    const measured = { [RUN]: "a".repeat(64), [MD]: "b".repeat(64) };
    const declared = { b12RunSha256: "a".repeat(64), claudeMdSha256: "b".repeat(64) };
    expect(pinMismatches(measured, declared)).toEqual([]);
  });

  it("FIRES on the stale pin, and names which one", () => {
    const measured = { [RUN]: "a".repeat(64), [MD]: "b".repeat(64) };
    const declared = { b12RunSha256: "c".repeat(64), claudeMdSha256: "b".repeat(64) };
    const bad = pinMismatches(measured, declared);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
    expect(bad[0]!.declared).toBe("c".repeat(64));
    expect(bad[0]!.measured).toBe("a".repeat(64));
  });

  it("treats an ABSENT pin as a mismatch, never as a skip", () => {
    // b12-run.mjs:1066 checks presence only, so an absent pin already passes
    // every other check in the toolchain. Skipping it here would make the
    // absence invisible everywhere at once.
    const bad = pinMismatches({ [RUN]: "a".repeat(64), [MD]: "b".repeat(64) }, { claudeMdSha256: "b".repeat(64) });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
    expect(bad[0]!.declared).toBeNull();
  });

  it("treats a path missing from the index as a mismatch too", () => {
    const bad = pinMismatches({ [MD]: "b".repeat(64) }, { b12RunSha256: "a".repeat(64), claudeMdSha256: "b".repeat(64) });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.subject).toBe(RUN);
    expect(bad[0]!.measured).toBeNull();
  });
});

describe("b12-pins-check — against a real index", () => {
  /** A repository whose HEAD is self-consistent, returned with its paths. */
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

  it("passes when the index is self-consistent", () => {
    const root = seed();
    expect(pinMismatches(readIndexSubjects(root), readIndexConfig(root).pinned ?? {})).toEqual([]);
  });

  it("CATCHES THE CASE THE HEAD-READING ALARM CANNOT: harness staged, pin not re-pinned", () => {
    const root = seed();
    fs.writeFileSync(path.join(root, RUN), "// harness v2 — edited\n");
    git(root, ["add", RUN]);

    // The alarm's reading. HEAD still carries v1 and the v1 pin, so it is GREEN
    // — which is precisely why a stale pin survives every local gate and only
    // goes red in CI, after the commit exists.
    const atHead = sha256(execFileSync("git", ["show", `HEAD:${RUN}`], { cwd: root, maxBuffer: 1 << 26 }));
    expect(readIndexConfig(root).pinned!.b12RunSha256).toBe(atHead);

    // This guard's reading, on the same tree, at the same instant.
    const bad = pinMismatches(readIndexSubjects(root), readIndexConfig(root).pinned ?? {});
    expect(bad).toHaveLength(1);
    expect(bad[0]!.pin).toBe("b12RunSha256");
  });

  it("refuses a PARTIAL staging — config edited but not staged", () => {
    // Both sides come from the index for this reason. Re-pinning in the working
    // tree and forgetting to stage it is the same stale commit wearing a clean
    // working tree, and reading the config off disk would call it green.
    const root = seed();
    fs.writeFileSync(path.join(root, RUN), "// harness v2 — edited\n");
    git(root, ["add", RUN]);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "b12-corpus/manifest-config.json"), "utf8"));
    cfg.pinned.b12RunSha256 = sha256(fs.readFileSync(path.join(root, RUN)));
    fs.writeFileSync(path.join(root, "b12-corpus/manifest-config.json"), JSON.stringify(cfg, null, 2));

    expect(pinMismatches(readIndexSubjects(root), readIndexConfig(root).pinned ?? {})).toHaveLength(1);

    // And goes green once the re-pin is actually staged.
    git(root, ["add", "b12-corpus/manifest-config.json"]);
    expect(pinMismatches(readIndexSubjects(root), readIndexConfig(root).pinned ?? {})).toEqual([]);
  });
});
