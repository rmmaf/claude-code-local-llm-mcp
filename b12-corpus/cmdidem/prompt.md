`npx vitest run tests/claude-md.test.ts` is failing. A CLAUDE.md that already carries an OLDER version of the delegation-policy block is no longer recognised as already-installed: startup reports it as appended, and the file comes back carrying two policy blocks instead of the one the user already has.

Find the cause and fix it. Stay inside `src/claude-md.ts`. The tests are correct as written —
do not change them.
