`npx tsc -p tsconfig.json --noEmit` is failing in `src/config.ts`. The private reader that pulls a number
out of the environment declares an options bag whose one field no longer admits the flag value its single
caller passes for the setting that is allowed to be zero.

Find the cause and fix it. Stay inside `src/config.ts`. The tests are correct as written —
do not change them.
