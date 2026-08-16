`npx vitest run tests/models-csv.test.ts` is failing. Model rows are coming back with the
wrong objective: an ordinary two-column row now has an empty objective, and a row that
carries extra columns picks up text from one column too far to the right.

Find the cause and fix it. Stay inside `src/models-csv.ts`. The tests are correct as written —
do not change them.
