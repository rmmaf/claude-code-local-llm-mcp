`npx tsc -p tsconfig.json --noEmit` is failing in `src/llm-client.ts`. The code that reads token
accounting out of an LM Studio chat-completion response asks the parsed body for a usage field that
the shape the body was parsed into does not admit.

Find the cause and fix it. Stay inside `src/llm-client.ts`. The tests are correct as written —
do not change them.
