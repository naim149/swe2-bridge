# SWE2 bridge for Codex

Use your installed Devin CLI as an additional worker in Codex. Persistent assignments support follow-ups in the same Devin session, structured permissions, declared checks, and a shared pool of up to four independent workers. Version 0.3 adds prepared Git review comparisons, optional quiet waits, and retrievable final reports.

Your existing task, role, and model-selection rules choose when to use Devin alongside native Codex agents. The plugin adds no routing priorities and does not add an entry to Codex's native model picker.

**Status:** experimental. Real macOS evidence covers session/edit/check behavior, images, follow-ups, crash recovery, and the version 0.3 review/wait/report additions. Linux remains experimental and Windows is unsupported. See [verification](VERIFICATION.md) for tested behavior and qualification limits.

## How it runs

Codex starts a local Node.js MCP server over stdio. The bridge drives your local Devin CLI through its Agent Client Protocol (ACP), and Devin uses your authenticated account for remote model inference.

There is no central bridge service to host, listening HTTP port, or account managed by this project. Each person installs and runs their own copy. Publishing this repository shares the source and setup process; it does not publish the plugin to the official Codex directory or create a universal one-click installation link.

## Install locally

You need:

- macOS, Node.js 22 or later, npm, and Git.
- A Codex build with local plugins and the `codex plugin` commands.
- Devin CLI installed, authenticated, and able to use your selected model. Account access is separate from this project.

```sh
git clone https://github.com/naim149/swe2-bridge.git
cd swe2-bridge
npm ci --ignore-scripts
npm run doctor
npm run install:local
```

Resolve any prerequisite reported by `doctor`, then rerun it. These setup commands do not submit a model task. The installer creates a machine-specific plugin under `.local/marketplace/plugins/swe2-bridge`, registers the local marketplace `swe2-bridge-local`, and installs `swe2-bridge@swe2-bridge-local` in Codex.

**Start a fresh Codex task after installation.** Ask Codex to use the Devin worker for a bounded task. Keep the clone in place: its local installation is used by Codex.

- [Full local setup, configuration, updates, and troubleshooting](docs/LOCAL_SETUP.md)
- [Setup guide for an agent](docs/AGENT_SETUP.md)
- [Worker contract and integration example](docs/WORKER_CONTRACT.md)

## Tools

| Tool | Purpose |
| --- | --- |
| `devin_preflight` | Check a structured assignment and prerequisites without inference. |
| `devin_run` | Start an assignment, or return its existing job for the same identity and revision. |
| `devin_message` | Create the next revision as a new job in the same Devin session. |
| `devin_wait` / `devin_wait_many` | Collect progress with per-job cursors, or opt into compact quiet waits for new outcomes and attention. |
| `devin_report` | Retrieve a finished job's retained answer and separate execution, evidence, policy, verification, and acceptance states. |
| `devin_list` | Discover persisted jobs and recover assignment identities. |
| `devin_respond` | Approve an allowed declared check once, deny a request, or answer a requested form. |
| `devin_cancel` | Stop a job. Changes already made remain in the workspace. |
| `devin_record_check` | Attach caller-reported evidence from a native or other authorized executor. |

Waits default to `mode: "progress"`. Optional `mode: "quiet"` ignores ordinary progress and returns compact state on a new terminal outcome, actionable request, error, or timeout. Pass each job's `next_token` back as `after_token` to acknowledge what you have seen. Both modes wait up to 55 seconds, defaulting to 10. Cancelling a wait stops only the wait; use `devin_cancel` to stop the worker. See the [worker contract](docs/WORKER_CONTRACT.md) for cursor and acknowledgment details.

For a Git review, add `review: {base_sha, head_sha}` with explicit immutable commit IDs to a `read` assignment. The bridge prepares a bounded complete comparison diff, changed-file metadata, and applicable head-revision `AGENTS.md` files. These comparison IDs are separate from the assignment's `base_sha`, which asserts checkout HEAD. Missing or unsupported evidence blocks preparation; no Git/history or shell tools are added to the reviewer. See [review preparation](docs/WORKER_CONTRACT.md#prepared-git-reviews) for coverage and limits.

After a turn finishes, `devin_report` retrieves its retained answer independently of the rolling event buffer. A completed answer can coexist with denied actions or incomplete verification. `task_accepted: false` means the Lead has not accepted the work; inspect all outcome fields before deciding whether it meets the task.

The supported model IDs are exactly `swe-2-medium` (default), `swe-2-high`, and `swe-2-max`. The selected model must be available to your Devin account; aliases and silent fallback are not accepted.

Assignments use one of three execution profiles:

| Profile | Authorized work |
| --- | --- |
| `read` | Investigation; delegated writes and shell checks are denied. |
| `edit` | Edits to explicit `owned_paths`; checks are handed to a native executor. |
| `edit_check` | Owned edits plus exact declared checks assigned to Devin, with command and working directory enforced. |

The bridge enforces delegated filesystem writes and check permissions, but it is **not an OS sandbox**. Other CLI tools, approved shell commands, and Git's evidence gaps limit isolation and observation. Review the [worker contract](docs/WORKER_CONTRACT.md) before assigning work.

The shared external pool allows up to four jobs in independent checkouts. The Lead also counts native and external workers against the caller's existing budget and coordinates named resources. Stable assignment IDs and revisions prevent a repeated request from blindly rerunning the same work.

## Permissions and private data

Trust is established for the specific assignment directory, using an existing native trust record or an explicit caller acknowledgment. Profiles determine execution policy; no global trust or permission setting is changed. Permission and form questions appear as attention requests. Only declared, allowed checks can be approved through the bridge.

Job prompts, session records, logs, and Git snapshots are stored locally under `~/.local/share/devin-bridge` by default. They can contain source code and sensitive data. Keep them out of public issues and commits. Read [SECURITY.md](SECURITY.md) for the trust boundary and reporting guidance.

## Verification and contributions

`npm run check` and `npm test` run local source and regression checks without model inference. Real acceptance checks use disposable workspaces and the installed CLI. [VERIFICATION.md](VERIFICATION.md) records versions, observed results, and remaining gaps; it is not a model benchmark or a guarantee for arbitrary projects.

Contributions are welcome, especially reproducible bug reports, installation portability, and results from bounded real-environment checks. Start with [CONTRIBUTING.md](CONTRIBUTING.md). The project is licensed under [MIT](LICENSE).

This is an independent community project; it is not an official OpenAI or Cognition integration.
