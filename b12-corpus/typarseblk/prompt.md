`npx tsc -p tsconfig.json --noEmit` is failing in `src/parse.ts`. The helper that locates a
closing fence on its own line is declared to always find one, and a segment with no such
line has nothing to report.

Find the cause and fix it. Stay inside `src/parse.ts`. The tests are correct as written —
do not change them.
