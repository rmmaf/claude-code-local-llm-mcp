`npx vitest run tests/contract-probe.test.ts` is failing. A response that replaces a file's body with a `// ... rest of the file unchanged ...` comment is no longer credited with any elision marker. The scorer still calls that response elided — but only because the lines are gone, and it reports the text that admits the elision as if nothing had been found.

Find the cause and fix it. Stay inside `src/contract-probe.ts`. The tests are correct as written —
do not change them.
