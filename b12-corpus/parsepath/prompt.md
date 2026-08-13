`npx vitest run tests/parse.test.ts` is failing in `src/parse.ts`. A `<file …>` block whose path attribute is written with apostrophes instead of double quotes is not recognized as a block at all.
The file it declares is simply absent from the parse result — no content, no entry in extras, no unclosed-block warning.

Find the cause and fix it. Stay inside `src/parse.ts`. The tests are correct as written —
do not change them.
