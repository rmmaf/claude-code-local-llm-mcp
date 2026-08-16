`npx vitest run tests/models-csv.test.ts` is failing. Comment lines in the model
catalog CSV are no longer being skipped, so a commented-out row is being read as a real
model entry.

Find the cause and fix it. Stay inside `src/models-csv.ts`. The tests are correct as
written — do not change them.
