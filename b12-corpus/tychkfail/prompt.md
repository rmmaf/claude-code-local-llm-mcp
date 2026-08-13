`npx tsc -p tsconfig.json --noEmit` is failing in `src/checks/parsers.ts`. The small constructor every
tool parser funnels its findings through no longer guarantees that the one field it actually dereferences
is present, so normalising the message trips strict null checking.

Find the cause and fix it. Stay inside `src/checks/parsers.ts`. The tests are correct as written —
do not change them.
