`npx vitest run tests/lms.test.ts` is failing. When several models are loaded and the
request names none of them, the context-length pre-flight is supposed to decline to
guess. It has started guessing in at least one case where it should not.

Find the cause and fix it. Stay inside `src/lms.ts`. The tests are correct as written —
do not change them.
