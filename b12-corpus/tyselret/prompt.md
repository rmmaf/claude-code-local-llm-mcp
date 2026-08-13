`npx tsc -p tsconfig.json --noEmit` is failing in `src/selection.ts`. A private helper that
collects the comparison forms of a model id is declared to hand back a different kind of
collection than the one it builds, and the lookup that consumes it no longer type-checks.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as written —
do not change them.
