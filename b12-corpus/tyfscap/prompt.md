`npx tsc -p tsconfig.json --noEmit` is failing in `src/fs-safety.ts`. The context-window pre-flight reads the loaded model's context length as if it were always known, but the caller is explicitly allowed to say the window is unknown — which is the very case this check is written to skip rather than guess at.

Find the cause and fix it. Stay inside `src/fs-safety.ts`. The tests are correct as written —
do not change them.
