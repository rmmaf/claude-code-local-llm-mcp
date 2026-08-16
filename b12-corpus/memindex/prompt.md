`npx vitest run tests/memory.test.ts` is failing in `src/memory.ts`. When the first free-RAM probe on macOS is unavailable and the fallback probe supplies the number, the reported provenance still credits the probe that failed.
The figure is right but the label attached to it names a command that did not produce it, so callers echoing that label to the user are stating something untrue.

Find the cause and fix it. Stay inside `src/memory.ts`. The tests are correct as written —
do not change them.
