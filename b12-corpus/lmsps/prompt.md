`npx vitest run tests/lms.test.ts` is failing in `src/lms.ts`. When `lms ps --json` reports a loaded model's window under the snake_case spelling some versions of `lms` emit, the parsed row comes back carrying no context length at all.
The pre-flight that is supposed to bound a whole-file answer is then left with nothing to check against for that model.

Find the cause and fix it. Stay inside `src/lms.ts`. The tests are correct as written —
do not change them.
