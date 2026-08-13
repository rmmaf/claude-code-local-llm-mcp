`npx tsc -p tsconfig.json --noEmit` is failing in `src/checks/parsers.ts`. The helper that
pulls a line number out of a stack trace is declared to always find one — but it is handed
a nullable file, and a stack that never mentions that file has no line to give.

Find the cause and fix it. Stay inside `src/checks/parsers.ts`. The tests are correct as written —
do not change them.
