`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/repair.ts`. The helper that renders the cumulative diff also hands back which files it found changed — several of them, in general — but it is declared to hand back a single one, and both the helper itself and the result payload that carries the list contradict that.

Find the cause and fix it. Stay inside `src/tools/repair.ts`. The tests are correct as written —
do not change them.
