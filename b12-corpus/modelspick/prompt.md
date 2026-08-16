`npx vitest run tests/models-tool.test.ts` is failing. The `models` tool reports, per catalog model, whether LM Studio currently offers it — and that field now comes out wrong in both directions: unknown when the endpoint answered, and a definite "not offered" when the endpoint could not be reached at all.

Find the cause and fix it. Stay inside `src/tools/models.ts`. The tests are correct as written —
do not change them.
