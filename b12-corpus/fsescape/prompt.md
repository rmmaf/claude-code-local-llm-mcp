`npx vitest run tests/fs-safety.test.ts` is failing. Containment is no longer enforced: a relative path that climbs out of the project root resolves as if it were inside, and a symlink whose target sits outside the root is accepted rather than refused. Neither `path_escape` nor `symlink_escape` is raised any more.

Find the cause and fix it. Stay inside `src/fs-safety.ts`. The tests are correct as written —
do not change them.
