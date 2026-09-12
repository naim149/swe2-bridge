# SWE2 bridge for Codex

Use your installed Devin CLI as an additional worker in Codex. This experimental plugin provides a capability skill and three MCP tools: start a task, collect its result, and cancel it.

Your existing task, role, and model-selection rules choose when to use Devin alongside native Codex agents. The plugin adds no routing priorities and does not add an entry to Codex's native model picker.

**Status:** working proof of concept, tested on macOS with real Devin/SWE-2 calls. Linux is experimental and unverified. Windows is unsupported. See [verification and known limits](VERIFICATION.md).

## How it runs

Codex starts a local Node.js MCP server over stdio. That server starts your local Devin CLI in the working directory you provide. Devin uses your authenticated account for remote model inference.

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

## Tools

| Tool | Purpose |
| --- | --- |
| `devin_run` | Start a task with an absolute `cwd`, optional `model`, `scope`, and `timeout_seconds`. Returns a job ID. The deadline defaults to 900 seconds; range 1–3600. |
| `devin_wait` | Read a job by `job_id`. `wait_seconds` defaults to 10; range 0–30. Zero returns an immediate snapshot. |
| `devin_cancel` | Stop a job. Changes already made remain in the workspace. |

The default model is the explicit identifier `swe-2-medium`. A caller can pass another model available to their Devin account. A result includes the requested model and the model identity reported by Devin, when available.

For example, ask Codex:

> Use the Devin worker to inspect the parser in this project. Read only; identify why empty input fails and report the relevant files. Keep the task within this checkout and do not run commands or edit files.

Task scope is an instruction to the worker, **not a filesystem sandbox**. Devin runs with its configured permissions and the OS access of the user who starts Codex. Review the result and changed files before accepting the work. A completed process is not proof that its output is correct.

Each bridge instance runs one job at a time. Checkout locks coordinate bridge instances that share a state directory; native agents and other programs can still edit the same checkout. Coordinate file ownership or use separate worktrees. Non-Git workspaces have no Git change evidence.

## Permissions and private data

The default Devin permission mode is `accept-edits`, with workspace trust respected. Authentication, model access, workspace trust, and command approvals remain Devin requirements. Shell, build, and test commands can require approval that cannot be granted through these headless tools; the task then reports a block. The bridge does not silently change models or permissions to get past it.

Job prompts, logs, conversation exports, and Git snapshots are stored locally under `~/.local/share/devin-bridge` by default. They can contain source code and sensitive data. Keep them out of public issues and commits. Read [SECURITY.md](SECURITY.md) for the trust boundary and reporting guidance.

## Verification and contributions

The initial macOS checks used the real CLI and model: read/edit tasks, preservation of existing work, competing checkout locks, cancellation, deadlines, shutdown/reload, workspace trust, and a fresh Codex invocation. [VERIFICATION.md](VERIFICATION.md) records the tested versions, results, and remaining gaps. These small tasks establish integration behavior, not a model benchmark or a guarantee for arbitrary projects.

Contributions are welcome, especially reproducible bug reports, installation portability, and results from bounded real-environment checks. Start with [CONTRIBUTING.md](CONTRIBUTING.md). The project is licensed under [MIT](LICENSE).

This is an independent community project; it is not an official OpenAI or Cognition integration.
