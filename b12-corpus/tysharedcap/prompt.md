`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/shared.ts`. The helper that clips a generated summary to a maximum number of words no longer agrees with the word limits its callers hand it, and inside the helper the length comparison and the slice that enforce that limit no longer agree with it either.

Find the cause and fix it. Stay inside `src/tools/shared.ts`. The tests are correct as written —
do not change them.
