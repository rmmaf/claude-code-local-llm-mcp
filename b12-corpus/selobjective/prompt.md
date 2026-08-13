`npx vitest run tests/selection.test.ts` is failing. Packing several models into free RAM at
once is no longer greedy on the big models first — the pack comes back in the opposite order,
and a budget that should have gone to the largest model is being spent on the small ones.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as written —
do not change them.
