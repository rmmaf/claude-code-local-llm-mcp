`npx tsc -p tsconfig.json --noEmit` is failing in `src/fs-safety.ts`. The helper that normalises a resolved path to posix separators is declared to hand back a number, while what it actually computes — and what the safe-path record it feeds expects — is text.

Find the cause and fix it. Stay inside `src/fs-safety.ts`. The tests are correct as written —
do not change them.
