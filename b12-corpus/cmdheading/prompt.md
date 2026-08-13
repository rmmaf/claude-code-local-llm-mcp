`npx vitest run tests/claude-md.test.ts` is failing. The delegation-policy text this server installs into a project's CLAUDE.md no longer matches, byte for byte, the fenced block that `README.md` tells users to paste by hand.
The two copies have drifted, which is the exact failure this module was written to end.

Find the cause and fix it. Stay inside `src/claude-md.ts`. The tests are correct as written —
do not change them.
