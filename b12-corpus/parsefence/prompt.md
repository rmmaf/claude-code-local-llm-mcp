`npx vitest run tests/parse.test.ts` is failing in `src/parse.ts`. When a model wraps its whole answer in a bare code fence — three backticks with no language written after them — the fence is no longer recognized as wrapping the payload.
The caller gets the backtick lines back as part of the text instead of the content they enclose.

Find the cause and fix it. Stay inside `src/parse.ts`. The tests are correct as written —
do not change them.
