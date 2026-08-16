`npx vitest run tests/claude-md.test.ts` is red. `LOCAL_CODER_AUTO_CLAUDE_MD` has stopped doing
anything at all — every spelling leaves the setting at its default, valid ones included. There is no
warning either, which is the part that narrows it: the value is not being rejected, it is never seen.

Find the cause and fix it. Stay inside `src/config.ts`. The tests are correct as written —
do not change them.
