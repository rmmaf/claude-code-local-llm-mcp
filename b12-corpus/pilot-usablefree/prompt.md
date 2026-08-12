`npx vitest run tests/selection.test.ts` is failing. The memory budget used to pick a
model is reporting the whole of free memory as usable, which means models are being
selected that cannot actually fit — the safety margin has stopped being applied.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as
written — do not change them.
