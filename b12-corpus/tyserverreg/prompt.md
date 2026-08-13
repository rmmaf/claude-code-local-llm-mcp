`npx tsc -p tsconfig.json --noEmit` is failing in `src/server.ts`. One registered MCP tool handler
invokes its implementation with arguments the implementation's parameters do not accept, so the
server entry point no longer compiles.

Find the cause and fix it. Stay inside `src/server.ts`. The tests are correct as written —
do not change them.
