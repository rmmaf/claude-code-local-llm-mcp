`npm test` is failing in `tests/gate.test.ts`. When the failure cap keeps only a handful of findings out of a red check, the ones it keeps are the bare unlocated messages and the ones carrying a path and a line are the ones thrown away. The caller gets back the least actionable half of what the check found.

Find the cause and fix it. Stay inside `src/tools/gate.ts`. The tests are correct as written —
do not change them.
