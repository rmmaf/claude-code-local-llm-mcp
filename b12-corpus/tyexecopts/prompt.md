`npx tsc -p tsconfig.json --noEmit` is failing in `src/exec.ts`. The read-only git wrapper hands the
process runner an options object that does not satisfy the runner's options contract: a required
field is absent and an unrecognised one is present in its place.

Find the cause and fix it. Stay inside `src/exec.ts`. The tests are correct as written —
do not change them.
