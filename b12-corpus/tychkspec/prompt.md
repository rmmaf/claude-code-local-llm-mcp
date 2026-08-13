`npx tsc -p tsconfig.json --noEmit` is failing in `src/checks/config.ts`. The private guard that validates
a check entry's `category` no longer accepts the kind of value it is asked about: the entries come out of
`JSON.parse`, so every field reaches validation untyped, and the guard now refuses to be handed one.

Find the cause and fix it. Stay inside `src/checks/config.ts`. The tests are correct as written —
do not change them.
