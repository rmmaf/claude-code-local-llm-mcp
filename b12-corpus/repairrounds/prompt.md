`npx vitest run tests/repair.test.ts` is failing. Each round of the repair loop is supposed to record how many check failures stood before it and how many stood after it. The "after" figure now mirrors the "before" one, so every round reports that nothing moved — in the trace returned to the caller and in the per-round telemetry alike.

Find the cause and fix it. Stay inside `src/tools/repair.ts`. The tests are correct as written —
do not change them.
