`npx tsc -p tsconfig.json --noEmit` is failing in `src/memory.ts`. The macOS memory probe is declared
to always produce a reading, but three of its paths — an unparseable `sysctl` total, an unparseable
`vm_stat`, and anything thrown along the way — deliberately report that no reading was available.

Find the cause and fix it. Stay inside `src/memory.ts`. The tests are correct as written —
do not change them.
