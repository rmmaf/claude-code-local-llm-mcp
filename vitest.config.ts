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
    // The scratch-root sweep. See tests/setup.ts and the count in tests/helpers.ts.
    setupFiles: ["tests/setup.ts"],
  },
});
