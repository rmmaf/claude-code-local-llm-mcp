`npx tsc -p tsconfig.json --noEmit` is failing in `src/lms.ts`. A helper that reports a
numeric field from an `lms` JSON row is declared to always produce a number, but the row
it reads may simply not carry that field.

Find the cause and fix it. Stay inside `src/lms.ts`. The tests are correct as written —
do not change them.
