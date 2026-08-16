`npm test` is failing in `tests/status.test.ts`. `status` exists to tell a user whether LM Studio's server is answering. With the endpoint down — the probe throwing outright — it now reports the server as reachable anyway, and the catalog it returns states each model's availability as a known fact instead of leaving it unknown.

Find the cause and fix it. Stay inside `src/tools/status.ts`. The tests are correct as written —
do not change them.
