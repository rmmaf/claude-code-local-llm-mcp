`npx vitest run tests/selection.test.ts` is failing. Model ids that differ only in
letter case are no longer being treated as the same model, so a catalog entry written
one way stops matching the id LM Studio actually serves.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as
written — do not change them.
