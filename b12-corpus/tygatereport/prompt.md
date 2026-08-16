`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/gate.ts`. The internal helper that runs one check reports, alongside the check's report, how many bytes of raw output that check produced. What it now declares it hands back does not agree with the numbers it actually computes, nor with the running total the tool accumulates them into.

Find the cause and fix it. Stay inside `src/tools/gate.ts`. The tests are correct as written —
do not change them.
