# Project instructions for agents

SWE2 bridge is an experimental local Codex plugin that exposes the user's installed Devin CLI through MCP. Read `README.md` and the relevant guide in `docs/` before changing setup or behavior.

- Preserve the neutral worker capability. Existing user rules select among Devin and native agents; do not add routing priorities, change global agent instructions, or claim native model-picker integration.
- Keep changes scoped. Preserve unrelated user work and coordinate disjoint ownership when multiple agents edit the repository.
- Keep stdout reserved for MCP protocol messages; diagnostics belong on stderr.
- Enforce owned paths for delegated filesystem writes and exact declared check commands/cwds. These controls are not an OS sandbox and do not cover every built-in CLI tool. Keep assignment trust explicit; do not change global settings or silently substitute models.
- A completed process does not establish task acceptance. Inspect the answer, actual file changes, and verification evidence.
- Preserve assignment identity and revision deduplication. Follow-ups return a new job in the same session; interrupted or incomplete work needs explicit partial-work acknowledgment. Do not automatically replay mutations.
- Count native and external workers under the caller's budget; preserve the bridge's shared external capacity of at most four and named resource ownership.
- Use `npm ci --ignore-scripts`, then `npm run check` and `npm test` for relevant source changes. Regression tests and CI must not submit inference. Use `npm run doctor` and `devin_preflight` for prerequisites.
- Run real model checks only when authorized. Use disposable fixtures without private project data and test the behavior changed. Keep pending validation distinct from observed passes.
- Keep credentials, raw prompts/exports/logs/diffs, state directories, generated installations, and machine-specific configuration out of commits. Inspect the staged diff before committing.
- macOS is the tested platform. Linux remains experimental until verified; Windows is unsupported. Do not broaden claims from code inspection alone.
- Update the relevant docs and sanitized `VERIFICATION.md` when behavior or evidence changes. State exact versions, observed results, and remaining gaps.
