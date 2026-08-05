# STATE.md

Overwritten every session, never appended — `git log -p STATE.md` is the diary.
Ceiling: 25 lines below this header.

## Where I stopped

**B12'S TREATMENT ARM WAS NEVER GOING TO RUN.** `--mcp-config` and
`--allowed-tools` are variadic and the positional prompt sat right after one, so
`claude --print` got no prompt and exited 1 before a session existed — measured,
three invocations. Control ends in a boolean flag and was immune: the arms would
have differed by whether they ran. Fixed in `observe()` and in the Mac script
with two guards, a non-variadic option before the prompt and `--`; it was also
the whole of the Mac pre-flight failure. A 26-finding adversarial review closed
the rest, and `.gitattributes` now pins LF under the append-only and hashed files.

## Next action

**Run the Mac script; send back the one artifact.** It now records which model
`repair` ACTUALLY used — the server picks its own, `$MODEL` only ever reached
`lms load` — whether claude wrote a transcript at all, and it deletes an artifact
that never got its provenance rather than shipping it. Then route real work
through `repair`, which has still never been called once. **Yours:** G-stop names
the cost meter as a delivery that must pay for itself and it structurally cannot;
G7's threshold; B14 3.978 vs 3.5.

## Do not redo

- **A check that cannot run reports the good outcome** — and now its twin, a
  check that cannot fail: `[ -n ]` on a concatenation, `DISABLE_AUTOUPDATER=1`
  read back from the environment the caller set on that very command line.
- **A signal handler that returns does not stop the script.** Ctrl-C ran the
  cleanup and continued, and could leave `passed: true` at the deliverable path.
- **The artifact path is a function of date and commit, so it repeats.** A
  refused run's leftover was found by the next run and stamped as its own.
