`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/status.ts`. This tool's contract is that every probe failure degrades to a reported field rather than an error, and the memory probe is one of the probes allowed to come back with nothing. The local that receives it no longer admits that outcome, so neither its starting value nor what the probe returns fits it.

Find the cause and fix it. Stay inside `src/tools/status.ts`. The tests are correct as written —
do not change them.
