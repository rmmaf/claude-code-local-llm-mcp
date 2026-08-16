`npx tsc -p tsconfig.json --noEmit` is failing in `src/selection.ts`. The variable that holds
what the `/models` probe reported is declared as a single id, while the probe answers with
every id the endpoint serves — and the catalog join downstream expects the whole set.

Find the cause and fix it. Stay inside `src/selection.ts`. The tests are correct as written —
do not change them.
