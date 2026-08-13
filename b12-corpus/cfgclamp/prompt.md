`npx vitest run tests/claude-md.test.ts` is red. Setting `LOCAL_CODER_AUTO_CLAUDE_MD` to one of the
documented off-spellings no longer opts out: the loader calls the value invalid, warns, and keeps the
default. Not all of them — the ones that still work are what makes the variable look healthy.

Find the cause and fix it. Stay inside `src/config.ts`. The tests are correct as written —
do not change them.
