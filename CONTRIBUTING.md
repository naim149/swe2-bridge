# Contributing

This is an experimental local bridge between Codex and an installed Devin CLI. Small, focused contributions are welcome. Useful work includes reproducible bug fixes, installation portability, permission/error handling, and real-environment verification.

For a substantial feature or behavior change, open an issue describing the use case and proposed scope before building it. For a small fix, a pull request with a clear reproduction is enough.

## Development setup

Follow [local setup](docs/LOCAL_SETUP.md), or give [the agent guide](docs/AGENT_SETUP.md) to your coding agent. The source layout is intentionally small:

| Path | Responsibility |
| --- | --- |
| `src/server.mjs` | MCP tool schemas and stdio server lifecycle. |
| `src/session-manager.mjs` | Durable assignment revisions, sessions, attention, worker capacity, and results. |
| `src/assignment.mjs` | Assignment normalization, readiness, attachments, and evidence assessment. |
| `src/acp-client.mjs` | Devin ACP transport, session control, and process lifecycle. |
| `src/check-executor.mjs` | Exact declared commands, working directories, approvals, and terminal evidence. |
| `src/runner.mjs` | Shared Git evidence, process/lock helpers, and legacy job compatibility. |
| `scripts/` | Local installation and prerequisite checks. |
| `skills/devin/` | The Codex capability skill. |
| `.codex-plugin/plugin.json` and `.mcp.json` | Public plugin metadata and MCP configuration. |

Install pinned dependencies and run the inexpensive source checks:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run doctor
```

Keep generated installations, dependencies, real job artifacts, and credentials out of Git. Do not edit public files to contain your machine's absolute installation paths.

## Design constraints

- Devin remains an additional worker. Preserve native subagent behavior and existing user model-selection rules.
- Keep assignments durable: stable identity, consecutive revisions, explicit follow-up, and no blind replay. Bound output, cursor delivery, and deadlines.
- Keep stdout reserved for MCP messages. Send diagnostics to stderr.
- Enforce ownership in delegated filesystem writes and exact declared check commands/cwds. Do not claim an OS sandbox or complete coverage of built-in CLI tools.
- Preserve workspace changes when work fails, is interrupted, or is cancelled. Inspect them before retrying.
- Accept only the three exact SWE-2 model IDs. Do not change model, widen an approval, alter global trust, or repeat potentially mutating work to hide a failure.
- Preserve caller budgeting across native and external workers, and coordinate explicit resource ownership. The shared bridge pool has a separate capacity of 1–3.
- Distinguish process completion, evidence availability, and acceptance of the generated work.

## Check the behavior you change

Run the existing regression suite and add focused coverage for meaningful contract or lifecycle changes. `npm test` and CI run local checks without model inference; they do not establish account access or full Devin behavior. Complement them with small real integration checks against the installed CLI and a disposable workspace when authorized. Do not use a private project as a test fixture.

Choose checks that match the change:

| Change | Useful verification |
| --- | --- |
| Documentation only | Follow the relevant steps, validate links/commands, and check for private paths or contradictory claims. Model invocation is usually unnecessary. |
| Installer or path resolution | Install from a fresh clone in a different directory, including spaces; run doctor; verify fresh Codex discovery. |
| Tool schema or result parsing | Exercise a real read task through MCP and inspect the structured result and final answer. |
| Assignment/session identity | Check repeated ID/revision deduplication, a consecutive follow-up with a new job ID and unchanged session ID, and explicit partial-work acknowledgment. |
| Workspace changes/evidence | Use a disposable Git repository with existing tracked and untracked changes; verify the intended edit and preservation of unrelated work. |
| Process lifecycle or locks | Exercise cancellation, a short deadline, worker-pool capacity, checkout/resource contention, and restart/recovery as relevant. Check owned process cleanup and retained partial changes. |
| Trust or permission handling | Check assignment trust, an exact check with one-time approval, denial of an undeclared command, and a bounded form response. Verify the command's actual cwd. |
| Evidence/attachments | Check native evidence provenance, attachment content/capability handling, ignored-file limits, and honest incomplete/truncated results. |

For a release or significant runner change, review the gaps in [VERIFICATION.md](VERIFICATION.md). An abrupt-termination check should target only the disposable bridge and its recorded worker, never broad process-name matches or unrelated sessions. Do not delete live checkout locks to force a pass.

Record the OS, Node version, Codex version, Devin CLI version, exact model ID, commands/scenario, expected result, and observed pass/fail. Distinguish a prerequisite block from a failed implementation. Keep raw artifacts private; public evidence should be sanitized.

## Pull requests

Explain the concrete problem and resulting behavior. Include the relevant verification and any remaining limitation. Keep unrelated refactors and formatting changes separate. If a change cannot be tested on a platform, mark it unverified rather than expanding the support claim.

By submitting a contribution, you agree that it is provided under this repository's [MIT license](LICENSE).
