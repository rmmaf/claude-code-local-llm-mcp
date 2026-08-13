`npx vitest run tests/gate.test.ts` is red. Autodetection now proposes an `eslint` check for a project
that merely lists eslint among its dependencies with no eslint configuration anywhere on disk — the case
the file's own doc comment calls out as worse than a missing check, because the command it proposes cannot
succeed and teaches the caller to ignore the gate.

Find the cause and fix it. Stay inside `src/checks/config.ts`. The tests are correct as written —
do not change them.
