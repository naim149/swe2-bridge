# Verification and current limits

Status: experimental public release. These checks establish observed integration behavior, not exhaustive reliability or a model benchmark. Verification used the real installed Devin CLI, real MCP connections, and disposable Git workspaces. There is no mocked Devin executable or model-test suite.

## Environment tested

Maintainer verification on September 12, 2026:

| Component | Version or setting |
| --- | --- |
| Operating system | macOS 26.5.2, Apple Silicon (`arm64`) |
| Codex desktop / CLI | `26.908.40834` / `0.154.0-alpha.6.2` |
| Devin CLI | `3000.10.23 (deb81600)` |
| Node.js / MCP SDK | `22.23.1` / `1.30.0` |
| Model | `swe-2-medium`, confirmed from actual conversation exports |
| Account | Authenticated Devin Pro account; each user supplies their own account |
| Bridge defaults | `accept-edits`, workspace trust enabled |

macOS is the tested platform. Linux is explicitly experimental and unverified. Windows is unsupported. Source checks running on Linux CI do not establish Linux runtime support.

## Passed real-environment checks

| Scenario | Observed outcome |
| --- | --- |
| Model access and reading | A real SWE-2 task returned the expected fixture contents without editing files. |
| MCP initialization and discovery | Actual SDK clients connected to the stdio server and discovered the three tools. An invalid directory was rejected before starting a worker. |
| Editing and acceptance | SWE-2 changed a function from subtraction to addition. Parent checks confirmed positive and negative examples returned the expected results. |
| Preserve existing work | Uncommitted tracked notes and an untracked user file remained byte-for-byte unchanged. |
| Git evidence | A real read-only worker ran while the test driver independently made a fixture commit and an index-only change with unchanged working-file contents. Both paths and the HEAD change were reported. This checks evidence collection; it does not attribute those driver changes to SWE-2. |
| Checkout locking | A competing bridge instance returned `WORKSPACE_BUSY` while another job owned the checkout. |
| Cancellation | Cancellation and repeated cancellation returned a terminal result; the owned process group was confirmed absent. |
| Deadline | A one-second deadline returned `timed_out` / `DEADLINE_EXCEEDED`; the process group was absent. |
| Graceful shutdown and reload | Closing the MCP connection interrupted a task. A fresh bridge read the persisted result, and the process group was absent. |
| Abrupt shutdown and recovery | After forcibly stopping the bridge with `SIGKILL`, a fresh instance reported the interrupted job and cancelled its identifiable surviving worker. Missing final snapshots are reported as unknown changes. A subsequent job recovered the stale checkout lock and completed its deadline cleanup. Both process groups were absent. |
| Workspace trust | An untrusted fixture returned `WORKSPACE_UNTRUSTED`. After trusting only that fixture through Devin's normal prompt, the default configuration succeeded. |
| Shell approval refusal | Under `accept-edits`, a requested shell command required confirmation and was rejected by headless Devin. The bridge returned `blocked` / `PERMISSION_REQUIRED` with no file changes. The bridge did not change permissions. |
| Installed Codex workflow | A fresh ephemeral Codex CLI invocation loaded the installed skill, called `devin_run` and `devin_wait`, and received the exact SWE-2 Medium result with workspace trust enabled. |

Initial disposable read/edit probes explicitly skipped trust for those fixtures; the direct read probe used Devin's `auto` mode. Installed-plugin and subsequent default-policy checks used `accept-edits` with trust enabled after the specific fixture was trusted. No global trust setting was changed.

## Public installation checks

The repository installer was exercised using real Codex plugin commands and isolated Codex configuration directories. This avoids changing the maintainer's normal installation during the checks.

- First install and same-path reinstall succeeded; unchanged contents retained the same generated version.
- A checkout in a path containing spaces started without dependencies, reported the missing prerequisite, then passed dependency installation, plugin installation, and actual MCP discovery.
- The source launcher also started with a narrow macOS GUI-style `PATH`.
- Codex resolved relative plugin paths against its installed cache correctly.
- Removal left no bridge MCP server in the isolated configuration.
- Dry-run, missing-CLI failure, and removal/reinstallation from a relocated checkout behaved as documented.

These checks exercised fresh directories on the same Mac, not a second physical machine. A different checkout path requires removing the old marketplace registration before registering the replacement; see the [relocation procedure](docs/LOCAL_SETUP.md).

## Findings addressed during verification

A deadline check exposed a transient macOS process-group cleanup error. The runner now suppresses that error only after confirming that the group has disappeared; unresolved cleanup retains the lock. The affected real deadline/shutdown checks passed afterward. Apple's [process-group signaling implementation](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_sig.c) supports the suspected zombie-group explanation; the transient process state itself was not captured.

Review also found that parseable but incomplete exports and dirty-file-only comparisons could overstate completion evidence. The bridge now requires a recognizable ATIF-v1 export ending in an agent answer and snapshots the index and committed tree. The live shell check confirmed why this matters: Devin can exit zero after refusing a permission prompt, without producing a final answer. That outcome is now reported as a permission block.

Node/launcher syntax, plugin metadata, skill validation, and independent code review were also checked. CI performs dependency installation, syntax checks, and JSON parsing without Devin authentication or inference. CI success alone is not an end-to-end test.

## Further verification worth contributing

Before broader reliability claims, obtain evidence for additional macOS installations, Linux, longer engineering tasks, simultaneous native-agent coordination, model/account failures, network interruptions, large repositories, and disk failures. Shell approvals cannot be granted through this headless bridge; workflows requiring them need an appropriate explicit permission decision outside the bridge.

A process exit is separate from accepting the generated work. Snapshot comparisons can include concurrent edits; ownership instructions are not filesystem isolation. Non-Git workspaces have no Git change attribution. One job runs at a time per bridge instance, and locks only coordinate bridges sharing the same state directory. Uncertain process ownership remains a conservative block.

Raw job records, prompts, exports, logs, and Git snapshots remain private under the local state directory. Maintainer evidence summaries are retained in ignored local files. Do not publish those raw artifacts as test fixtures; submit a sanitized reproduction with versions, expected/actual behavior, and the relevant result instead.

SWE-2 followed the bounded read/edit assignments successfully. These tasks are too small to rank it against other models or establish performance on complex projects.
