`npx vitest run tests/contract-probe.test.ts` is failing. Elision markers that are a bare ellipsis line come back labelled as the prose-phrasing kind of marker instead. The detector still finds them and the responses are still scored elided, but every marker it reports is filed under the wrong tier, so the artifact can no longer tell the two detectors apart.

Find the cause and fix it. Stay inside `src/contract-probe.ts`. The tests are correct as written —
do not change them.
