`npx vitest run tests/parse.test.ts` is failing in `src/parse.ts`. Output that was cut off mid-reasoning — a thinking block that opens and never closes, the signature of a truncated response — is no longer trimmed at the point where the reasoning starts.
The dangling reasoning survives into the returned text instead of being dropped.

Find the cause and fix it. Stay inside `src/parse.ts`. The tests are correct as written —
do not change them.
