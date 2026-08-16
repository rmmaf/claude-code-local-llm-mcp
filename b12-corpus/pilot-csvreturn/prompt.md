`npx tsc -p tsconfig.json --noEmit` is failing. The declared return type of the model
catalog CSV parser no longer describes what the function actually returns, and every
caller that treats the result as a collection is now a type error.

Find the cause and fix it. Stay inside `src/models-csv.ts`. Do not silence the error
with a cast or a suppression comment — make the declaration true again.
