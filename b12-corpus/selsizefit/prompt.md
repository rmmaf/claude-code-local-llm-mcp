`npx vitest run tests/selection.test.ts` is failing. The per-model fit verdict in the catalog
report is coming out backwards: models comfortably smaller than the usable free-RAM budget
are reported as not fitting, and models far larger than it are reported as fitting.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as written —
do not change them.
