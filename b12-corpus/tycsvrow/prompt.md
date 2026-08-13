`npx tsc -p tsconfig.json --noEmit` is failing in `src/models-csv.ts`. The private splitter
that turns CSV text into records is declared to produce a flat run of strings rather than one
row of fields per record, so both what it returns and how each row is read are now untrue.

Find the cause and fix it. Stay inside `src/models-csv.ts`. The tests are correct as written —
do not change them.
