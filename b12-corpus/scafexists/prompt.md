`npm test` is failing in `tests/scaffold.test.ts`. `scaffold` documents that it never overwrites anything and refuses an occupied target before it spends a single model call. A run whose target file already exists no longer refuses: it falls through the guard and goes on to call the local model.

Find the cause and fix it. Stay inside `src/tools/scaffold.ts`. The tests are correct as written —
do not change them.
