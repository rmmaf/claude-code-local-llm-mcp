`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/scaffold.ts`. The summary the tool returns quotes the first line of the caller's spec, and the value being handed to the word-capping helper is no longer something that helper will accept: the indexing that produces it is allowed to yield nothing, while the helper insists on text.

Find the cause and fix it. Stay inside `src/tools/scaffold.ts`. The tests are correct as written —
do not change them.
