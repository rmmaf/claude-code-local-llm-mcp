`npx tsc -p tsconfig.json --noEmit` is failing in `src/llm-client.ts`. The internal timeout wrapper
that both HTTP paths in that module go through no longer accepts the endpoint address either of
them builds for it.

Find the cause and fix it. Stay inside `src/llm-client.ts`. The tests are correct as written —
do not change them.
