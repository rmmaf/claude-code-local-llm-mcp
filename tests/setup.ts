import { afterAll } from "vitest";

import { sweepTempRoots } from "./helpers.js";

/**
 * Runs once per test FILE, registered before that file's own hooks — so vitest's
 * reverse-order `afterAll` puts this sweep LAST, after a suite has killed whatever child
 * processes were holding its scratch directories open.
 *
 * It exists because nine suites called `makeTempRoot` and never removed a thing; see the
 * count in `tests/helpers.ts`. Sweeping centrally rather than adding an `afterEach` to
 * each of them means the next suite someone writes is covered without having to know this
 * is a rule.
 */
afterAll(async () => {
  await sweepTempRoots();
});
