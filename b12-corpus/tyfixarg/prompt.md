`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/fix.ts`. This tool does exactly one thing — hand the caller's request on to the shared generation pipeline — and what it hands over no longer matches what that pipeline accepts.

Find the cause and fix it. Stay inside `src/tools/fix.ts`. The tests are correct as written —
do not change them.
