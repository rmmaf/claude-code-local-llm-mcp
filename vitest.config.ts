import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * THE SUITE HAD NO CONFIG AT ALL, so it ran on vitest's default `testTimeout` of 5000 ms
 * and `hookTimeout` of 10000 ms. That is one of the three reasons its answer moved between
 * identical runs; the others were teardown (`tests/helpers.ts`) and a scratch-directory
 * leak that had been growing since 2026-08-02 (`sweepTempRoots`).
 *
 * MEASURED, not assumed. `tests/b12-audit.test.ts:585` failed a full-suite run with
 * `Error: Test timed out in 5000ms.` and passed in a three-file selection. It builds a
 * scratch git repository with eight git subprocesses, and a git spawn on Windows costs
 * tens of milliseconds unloaded and several times that with four workers competing for the
 * disk — so it fits inside 5 s alone and does not in a full run. Nothing about that is a
 * defect in the test or in the code it exercises; it is a budget written for unit tests
 * being applied to a test that drives a real VCS.
 *
 * THIS ONLY SETS A FLOOR FOR TESTS THAT DECLARE NOTHING. The heavy suites already pass
 * their own budgets — 60 s and 90 s as a third argument to `it` — and those still govern.
 * Raising this number would not have saved any of them, which is worth stating because the
 * first reading of the evidence said no test declared a timeout at all: the grep could not
 * match `60_000` through the underscore.
 *
 * 30 s is deliberately not 60 or more: the point of a timeout is to catch a test that has
 * HUNG, and a budget so large that nothing can ever reach it stops being a check.
 * `hookTimeout` matches it because teardown now retries a locked removal for up to 5.5 s
 * before giving up, which leaves little room under the 10 s default.
 *
 * If a test needs longer than this, give THAT test its own timeout and say why, rather
 * than raising the number here — a global that keeps growing is how the hang detector was
 * lost in the first place.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The scratch-root sweep (tests/setup.ts, and the count in tests/helpers.ts) — declared
    // ONLY IF THAT FILE EXISTS UNDER THE ROOT BEING RUN, which is not the pedantry it looks
    // like.
    //
    // MEASURED. `b12-author.mjs` checks a corpus base by materialising the GREEN PARENT in a
    // detached worktree under `<repo>/.b12/` and running the task's predicate there. Vitest
    // resolves this config from above that worktree, so an unconditional `setupFiles` made
    // every suite at the parent die with `Cannot find module …/.b12/probe/tests/setup.ts` —
    // the parent commit predates tests/setup.ts and never had one. 29 of 29 test-red bases
    // were refused with "the parent is not green", which is the author telling the truth
    // about a file this config had broken.
    //
    // WORSE, AND THE REASON THIS IS A COMMENT AND NOT A ONE-LINE FIX: `verify-corpus --deep`
    // asserts each base's predicate FAILS, so a suite that cannot even load reads as a
    // present defect. The pilot re-verified green while every one of its predicates was
    // dying on a missing module. Green at the parent is trustworthy; red at the base is not,
    // and only the green half caught this.
    //
    // The residual is named and NOT closed: this config still governs a detached worktree it
    // does not belong to, so a later change here silently changes what "green at the parent"
    // means for a sealed corpus. The durable answer is a green parent whose own tree carries
    // its config.
    ...(existsSync(path.resolve("tests/setup.ts")) ? { setupFiles: ["tests/setup.ts"] } : {}),
  },
});
