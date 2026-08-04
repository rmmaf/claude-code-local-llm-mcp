<!-- local-coder:policy:begin v1 -->
## Local delegation policy
- Verify with mcp__local-coder__gate, never by running lint/tsc/tests through
  Bash. One call runs them all and returns only structured failures.
- When the gate is red and the fix is mechanical (type errors, failing
  assertions, lint, missing imports), call mcp__local-coder__repair instead of
  fixing and re-testing yourself. It loops locally and returns one diff.
- Delegate new-file creation from a spec to mcp__local-coder__scaffold.
- Use mcp__local-coder__implement only for bulk mechanical authoring — it saves
  the smallest part of the bill.
- Keep in Claude: architecture decisions, API design, subtle debugging,
  security-sensitive code, and final review of every diff before apply.
- Never paste file contents into tool arguments — pass relative paths.
- Escalate to yourself after 2 failed local attempts on the same unit.
<!-- local-coder:policy:end -->
