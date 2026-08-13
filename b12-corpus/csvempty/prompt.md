`npx vitest run tests/models-csv.test.ts` is failing. The fall back to the built-in catalog
fires exactly backwards: a CSV full of usable rows is thrown away in favour of the defaults,
while a CSV with nothing usable in it yields an empty catalog instead of the defaults.

Find the cause and fix it. Stay inside `src/models-csv.ts`. The tests are correct as written —
do not change them.
