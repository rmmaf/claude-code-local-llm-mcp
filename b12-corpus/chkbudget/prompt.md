`npx vitest run tests/gate.test.ts` is red. A `.local-coder/checks.json` carrying ONE malformed entry
no longer fails closed: that entry is dropped and the gate runs whatever was left, reporting passed.
Two malformed entries still refuse, which is exactly what makes the validation look like it works.

Find the cause and fix it. Stay inside `src/checks/config.ts`. The tests are correct as written —
do not change them.
