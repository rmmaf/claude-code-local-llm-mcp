`npx vitest run tests/lms.test.ts` is failing in `src/lms.ts`. A downloaded-model row whose size arrives under one of the alternate field spellings `lms ls --json` uses is now treated as sizeless.
Sizeless rows are skipped, so a model that really is on disk disappears from the catalog entirely instead of being listed with its size.

Find the cause and fix it. Stay inside `src/lms.ts`. The tests are correct as written —
do not change them.
