`npx tsc -p tsconfig.json --noEmit` is failing in `src/contract-probe.ts`. The record that describes one elision marker now admits only one of the two kinds of marker the detector actually produces — the detector still emits both, a bare-ellipsis line and a prose phrasing that stands in for dropped content.

Find the cause and fix it. Stay inside `src/contract-probe.ts`. The tests are correct as written —
do not change them.
