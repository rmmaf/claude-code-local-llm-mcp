`npm test` is failing in `tests/gate.test.ts`. The `gate` tool accepts a wall-clock ceiling for a whole call, and the suite that pins what a check is actually launched with is now seeing a value far larger than the ceiling the caller supplied. A single check can outlive the deadline its caller set, and so can the git coverage probe that follows it.

Find the cause and fix it. Stay inside `src/tools/gate.ts`. The tests are correct as written —
do not change them.
