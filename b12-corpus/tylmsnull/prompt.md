`npx tsc -p tsconfig.json --noEmit` is failing in `src/lms.ts`. The rows being collected for the downloaded-model catalog no longer typecheck against what that catalog is declared to hand back: the on-disk size a row carries is rejected as an unknown property, and the collected array is rejected as the function's result.

Find the cause and fix it. Stay inside `src/lms.ts`. The tests are correct as written —
do not change them.
