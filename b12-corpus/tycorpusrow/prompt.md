`npx tsc -p tsconfig.json --noEmit` is failing in `src/corpus.ts`. The helper that records working-tree
state alongside a captured failure now promises a patch in every case, while two of its own exit paths
deliberately report having none — the no-diff case and the over-the-cap case.

Find the cause and fix it. Stay inside `src/corpus.ts`. The tests are correct as written —
do not change them.
