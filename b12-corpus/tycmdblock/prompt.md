`npx tsc -p tsconfig.json --noEmit` is failing in `src/claude-md.ts`. The local that holds the current contents of a project's CLAUDE.md is declared as always being text, but the read that fills it is wrapped in a catch precisely because the file may not exist yet, and the code downstream still asks whether nothing came back.

Find the cause and fix it. Stay inside `src/claude-md.ts`. The tests are correct as written —
do not change them.
