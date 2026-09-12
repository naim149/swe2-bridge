# Contributing

This is an experimental local bridge between Codex and an installed Devin CLI. Small, focused contributions are welcome. Useful work includes reproducible bug fixes, installation portability, permission/error handling, and real-environment verification.

For a substantial feature or behavior change, open an issue describing the use case and proposed scope before building it. For a small fix, a pull request with a clear reproduction is enough.

## Development setup

Follow [local setup](docs/LOCAL_SETUP.md), or give [the agent guide](docs/AGENT_SETUP.md) to your coding agent. The source layout is intentionally small:

| Path | Responsibility |
| --- | --- |
| `src/server.mjs` | MCP tool schemas and stdio server lifecycle. |
| `src/runner.mjs` | Devin subprocesses, results, artifacts, checkout locks, and cancellation. |
| `scripts/` | Local installation and prerequisite checks. |
| `skills/devin/` | The Codex capability skill. |
| `.codex-plugin/plugin.json` and `.mcp.json` | Public plugin metadata and MCP configuration. |

Install pinned dependencies and run the inexpensive source checks:

```sh
npm ci --ignore-scripts
npm run check
npm run doctor
```

Keep generated installations, dependencies, real job artifacts, and credentials out of Git. Do not edit public files to contain your machine's absolute installation paths.

## Design constraints

- Devin remains an additional worker. Preserve native subagent behavior and existing user model-selection rules.
- Keep tool calls asynchronous: start, wait by job ID, cancel. Bound output and deadlines.
- Keep stdout reserved for MCP messages. Send diagnostics to stderr.
- Treat scope as worker instructions, not a security sandbox.
- Preserve workspace changes when work fails, is interrupted, or is cancelled. Inspect them before retrying.
- Do not automatically change models, relax permissions, disable trust, or repeat potentially mutating work to hide a failure.
- Distinguish process completion, evidence availability, and acceptance of the generated work.

## Check the behavior you change

Prefer small real integration checks against the installed CLI and a disposable workspace. A broad mock suite is not a contribution requirement. Do not spend another person's model account access without authorization, and do not use a real private project as a test fixture.

Choose checks that match the change:

| Change | Useful verification |
| --- | --- |
| Documentation only | Follow the relevant steps, validate links/commands, and check for private paths or contradictory claims. Model invocation is usually unnecessary. |
| Installer or path resolution | Install from a fresh clone in a different directory, including spaces; run doctor; verify fresh Codex discovery. |
| Tool schema or result parsing | Exercise a real read task through MCP and inspect the structured result and final answer. |
| Workspace changes/evidence | Use a disposable Git repository with existing tracked and untracked changes; verify the intended edit and preservation of unrelated work. |
| Process lifecycle or locks | Exercise cancellation, repeated cancellation, a short deadline, competing bridge instances, and restart/recovery as relevant. Check owned process cleanup and retained partial changes. |
| Trust or permission handling | Confirm a real block is surfaced under the normal settings; do not bypass it to make the test pass. |

For a release or significant runner change, review the gaps in [VERIFICATION.md](VERIFICATION.md). An abrupt-termination check should target only the disposable bridge and its recorded worker, never broad process-name matches or unrelated sessions. Do not delete live checkout locks to force a pass.

Record the OS, Node version, Codex version, Devin CLI version, exact model ID, commands/scenario, expected result, and observed pass/fail. Distinguish a prerequisite block from a failed implementation. Keep raw artifacts private; public evidence should be sanitized.

## Pull requests

Explain the concrete problem and resulting behavior. Include the relevant verification and any remaining limitation. Keep unrelated refactors and formatting changes separate. If a change cannot be tested on a platform, mark it unverified rather than expanding the support claim.

By submitting a contribution, you agree that it is provided under this repository's [MIT license](LICENSE).
