`npx vitest run tests/fs-safety.test.ts` is failing. The assembled-context pre-flight has stopped singling out the files that individually blow the per-file limit. A batch holding two oversized files and one small one is now reported as a whole-batch problem, with the innocent small file named alongside the two that are actually at fault, and under the wrong error code.

Find the cause and fix it. Stay inside `src/fs-safety.ts`. The tests are correct as written —
do not change them.
