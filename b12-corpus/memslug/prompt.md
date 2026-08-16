`npx vitest run tests/memory.test.ts` is failing in `src/memory.ts`. Free RAM derived from `vm_stat` comes out far too small: of the several page counts the measurement is supposed to add together, only one reaches the total.
A machine with tens of gigabytes free is reported as having almost none, which would refuse work that fits.

Find the cause and fix it. Stay inside `src/memory.ts`. The tests are correct as written —
do not change them.
