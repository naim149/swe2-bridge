# Project instructions for agents

SWE2 bridge is an experimental local Codex plugin that exposes the user's installed Devin CLI through MCP. Read `README.md` and the relevant guide in `docs/` before changing setup or behavior.

- Preserve the neutral worker capability. Existing user rules select among Devin and native agents; do not add routing priorities, change global agent instructions, or claim native model-picker integration.
- Keep changes scoped. Preserve unrelated user work and coordinate disjoint ownership when multiple agents edit the repository.
- Keep stdout reserved for MCP protocol messages; diagnostics belong on stderr.
- Scope instructions are not a sandbox. Preserve workspace trust and configured permissions, and surface blocks without silently changing settings or models.
- A completed process does not establish task acceptance. Inspect the answer, actual file changes, and verification evidence.
- Do not automatically retry potentially mutating work. Cancellation, timeout, and interruption preserve partial changes.
- Use `npm ci --ignore-scripts`, then `npm run check` for relevant source changes. Use `npm run doctor` for installation prerequisites; it must not submit inference.
- Run real model checks only when authorized. Use disposable fixtures without private project data and test the behavior changed. A mock suite is not required by default.
- Keep credentials, raw prompts/exports/logs/diffs, state directories, generated installations, and machine-specific configuration out of commits. Inspect the staged diff before committing.
- macOS is the tested platform. Linux remains experimental until verified; Windows is unsupported. Do not broaden claims from code inspection alone.
- Update the relevant docs and sanitized `VERIFICATION.md` when behavior or evidence changes. State exact versions, observed results, and remaining gaps.
