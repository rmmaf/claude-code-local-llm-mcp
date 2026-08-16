`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/models.ts`. The memory block of the `models` result converts the usable-free-RAM budget into gigabytes, but that budget is only a number when the memory probe actually produced a reading — when it did not, there is nothing to convert.

Find the cause and fix it. Stay inside `src/tools/models.ts`. The tests are correct as written —
do not change them.
