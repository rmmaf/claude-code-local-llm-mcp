`npx vitest run tests/selection.test.ts` is failing. A catalog name no longer matches the id
LM Studio actually serves when the served id spells its quantisation after an `@` —
`…-14b-instruct` against `…-14b-instruct@8bit` now comes back as no match at all.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as written —
do not change them.
