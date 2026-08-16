`npx vitest run tests/models-csv.test.ts` is failing. The model catalog CSV has no header
row, but the very first record of every file is now being thrown away, so a catalog whose
opening line is a real model comes back one entry short.

Find the cause and fix it. Stay inside `src/models-csv.ts`. The tests are correct as written —
do not change them.
