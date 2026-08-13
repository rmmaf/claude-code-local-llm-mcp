`npx tsc -p tsconfig.json --noEmit` is failing in `src/tools/shared.ts`. The record kept for the model attempt that finally produced usable output stores the server's stop reason, and the chat client reports that reason as absent whenever the response did not carry a usable one.

Find the cause and fix it. Stay inside `src/tools/shared.ts`. The tests are correct as written —
do not change them.
