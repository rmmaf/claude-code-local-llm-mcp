`npx vitest run tests/fs-safety.test.ts` is failing. The whole-file output pre-flight has become one token too strict: a request whose estimated answer lands EXACTLY on the usable budget is now refused, when sitting exactly at the bar is supposed to be allowed through. Only the boundary moved — requests well under and well over still behave.

Find the cause and fix it. Stay inside `src/fs-safety.ts`. The tests are correct as written —
do not change them.
