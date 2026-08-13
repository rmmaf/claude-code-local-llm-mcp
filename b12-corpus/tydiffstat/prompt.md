`npx tsc -p tsconfig.json --noEmit` is failing in `src/diff.ts`. The helper that counts added and
removed lines in a unified diff no longer produces the numeric pair its declared result type
promises — one of the two counters it accumulates is not a number.

Find the cause and fix it. Stay inside `src/diff.ts`. The tests are correct as written —
do not change them.
