`npx tsc -p tsconfig.json --noEmit` is failing in `src/config.ts`. The private reader for a 0–1 fraction
disagrees with itself and with both of its callers about what kind of value its fallback is: the two
settings that use it hand over the numeric defaults, and what it forwards to the numeric reader is
something else entirely.

Find the cause and fix it. Stay inside `src/config.ts`. The tests are correct as written —
do not change them.
