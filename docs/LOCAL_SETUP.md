# Local setup

The bridge runs on your computer as a stdio process started by Codex. You do not need a server, domain, cloud deployment, or inbound network port. Devin's model inference still uses your Devin account and remote service.

## Supported environment

| Component | Requirement |
| --- | --- |
| Operating system | macOS tested. Linux is an opt-in experiment with no live validation yet. Windows is unsupported. |
| Node.js | Version 22 or later, with npm. |
| Git | Available on `PATH`, including when tasks use non-Git directories. |
| Codex | A build with local plugin support and the `codex plugin` commands. |
| Devin | Installed CLI, normal local login, and account access to the requested model. |

The installer checks the current machine rather than assuming the maintainer's paths. On macOS it can find the CLI bundled with Devin and the Codex CLI bundled with the desktop app when they are not on `PATH`.

## 1. Get the source and dependencies

```sh
git clone https://github.com/naim149/swe2-bridge.git
cd swe2-bridge
npm ci --ignore-scripts
npm run doctor
```

Read the doctor's output and resolve missing prerequisites. It checks versions, CLI support, dependencies, and authentication without submitting inference work. `npm run doctor -- --json` gives structured output for an agent. A failed required prerequisite produces a nonzero exit; do not interpret it as successful setup.

If the source is already present, use that checkout. Avoid keeping several installations of this plugin enabled under different marketplace names.

## 2. Authenticate Devin

Use Devin's normal CLI login. When `devin` is on `PATH`:

```sh
devin auth status
devin auth login
devin models list --format json
```

Run `auth login` only if authentication is needed. Complete the browser or terminal flow yourself; do not paste passwords, tokens, cookies, or credential files into Codex or an issue.

For the bundled macOS CLI, use its full path:

```sh
export DEVIN_CLI_PATH="/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
"$DEVIN_CLI_PATH" auth status
"$DEVIN_CLI_PATH" auth login
"$DEVIN_CLI_PATH" models list --format json
```

Confirm that your account can use the intended exact model: `swe-2-medium`, `swe-2-high`, or `swe-2-max`. The default is `swe-2-medium`; aliases and other models are not accepted by this version. Listing models and being logged in do not by themselves establish that a real inference request will succeed.

## 3. Install the local Codex plugin

From the repository root:

```sh
npm run doctor
npm run install:local
```

The installer stages the plugin and runtime dependencies inside this clone at `.local/marketplace/plugins/swe2-bridge`, generates local executable paths, registers the marketplace `swe2-bridge-local`, and adds `swe2-bridge@swe2-bridge-local` to Codex. The public source contains no maintainer-specific installation paths or credentials.

Use `npm run install:local -- --dry-run` to inspect the proposed installation without registering or installing the plugin. `npm run install:local -- --help` lists supported flags and environment overrides.

Keep the clone and its `.local` directory in place while using the installation. If you replace a CLI or Node executable, rerun the installer. Moving the clone requires the marketplace relocation steps below.

For Linux contributors, both commands require explicit acknowledgment:

```sh
npm run doctor -- --experimental-linux
npm run install:local -- --experimental-linux
```

That flag permits an unverified platform; it does not establish support. Use only a disposable workspace for initial live checks and record the OS, CLI versions, and observed behavior.

## 4. Start a fresh Codex task

Existing tasks can retain an older set of tools. Start a new task after installation or update, then ask it to use the Devin worker. Version 0.2 exposes nine tools, from `devin_preflight` through session follow-ups and verification evidence, plus the `devin` skill. Check the complete [tool contract](WORKER_CONTRACT.md). The UI may prefix tool names with the MCP server name.

The worker is available alongside native agents. Existing user rules decide when to use it; installation does not rewrite those rules or add a native model-picker option.

Choose a profile for each assignment: `read`, `edit`, or `edit_check`. Edit profiles require explicit owned paths. Only `edit_check` allows exact declared commands assigned to Devin; their actual working directories are enforced by the bridge terminal handlers. Checks marked `approval: "ask"` produce an attention request that can be approved once with `devin_respond`. Unknown commands cannot be approved without amending the assignment or handing the work to a native executor.

## 5. Optional real acceptance check

This step submits a real Devin model task. Run it only when you intend to use the account for that purpose. Setup can finish before a live check.

Create a disposable Git fixture with no project data:

```sh
bridge_fixture="$(mktemp -d "${TMPDIR:-/tmp}/swe2-bridge-check.XXXXXX")"
git init "$bridge_fixture"
printf '%s\n' 'bridge-check-7d92' > "$bridge_fixture/probe.txt"
printf '%s\n' "$bridge_fixture"
```

Use the directory's existing native Devin trust record, or explicitly acknowledge the disposable directory after reviewing it. For the latter, set `workspace_trust: "acknowledged"` and provide a `trust_reason` explaining that you created and inspected this fixture. The acknowledgment applies to the assignment; it does not update global Devin trust.

In a fresh Codex task, substitute the printed absolute path:

> Prepare an assignment with profile `read`, model `swe-2-medium`, cwd `/absolute/path/to/the/fixture`, revision 1, a stable assignment ID specific to this fixture, and a 120-second timeout. Read `probe.txt` and return its exact contents. Do not edit files, execute shell commands, use network tools, or work outside the fixture. Establish trust only for this reviewed directory. Call `devin_preflight`; if ready, call `devin_run` with that same assignment. Save its job ID and collect results with `devin_wait`, passing each returned `next_cursor` as `after_cursor`. Verify the marker and check that the file is unchanged. Report blocks without changing models or silently resubmitting work.

Pass criteria: preflight is ready, one job runs, the final answer contains `bridge-check-7d92`, the requested/resolved model is exact, and the file remains unchanged. Review evidence completeness, cursor gaps, and truncation. A job can finish but fail task acceptance.

For an edit check, create a separate disposable fixture with a deliberately incorrect small function and pre-existing tracked and untracked changes. Set `owned_paths` to only that function. Use `edit_check` with an exact declared verification command, or `edit` with a native check handoff. Inspect its diff and actual check evidence, and confirm the other files are unchanged. Follow-up, permission, concurrency, and recovery scenarios are described in [WORKER_CONTRACT.md](WORKER_CONTRACT.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

## Configuration

The installer records environment overrides in the generated `.mcp.json` under the ignored staged plugin, not in public source. Node's executable path is resolved during setup. Set overrides in your shell before `npm run install:local` and supply the same intended configuration when reinstalling.

| Variable | Behavior |
| --- | --- |
| `CODEX_CLI_PATH` | Optional Codex executable override used by setup. |
| `DEVIN_CLI_PATH` | Explicit Devin executable path. Otherwise resolves `devin` on `PATH`, then the known macOS app location. |
| `DEVIN_BRIDGE_MODEL` | Default `swe-2-medium`; use exactly that model, `swe-2-high`, or `swe-2-max`. An assignment can override the default. |
| `DEVIN_BRIDGE_MAX_WORKERS` | External pool capacity, 1–3; default 3 across bridge instances sharing state. The caller also counts native workers against its overall budget. |
| `DEVIN_BRIDGE_STATE_DIR` | Default `~/.local/share/devin-bridge`; stores prompts, sessions, logs, job state, snapshots, and locks. |

Execution policy and trust now belong to each structured assignment: `profile`, `checks`, `workspace_trust`, and `trust_reason`. Remove old permission-mode or global-trust overrides from a previous installation; they are not the version 0.2 control surface.

For example, select an explicitly available model before installation:

```sh
DEVIN_BRIDGE_MODEL=swe-2-medium npm run install:local
```

For direct MCP development, `npm start` starts the server on stdin/stdout. It waits for an MCP client; it is not a web server and does not display a webpage. Keep diagnostics on stderr so the protocol on stdout stays valid.

## Update or remove

Stop active Devin jobs before replacing the installed runtime. From the clone:

```sh
git pull --ff-only
npm ci --ignore-scripts
npm run doctor
npm run install:local
```

Start a fresh Codex task after the reinstall. If the clone contains local changes, resolve them before pulling; do not discard them as part of setup. Jobs from version 0.1 have no ACP session and cannot become resumable version 0.2 sessions; inspect their existing results and partial changes before assigning further work.

If you move the clone or switch to a different checkout, Codex's existing `swe2-bridge-local` registration still refers to the previous directory. With active jobs stopped, remove this plugin and marketplace registration, then run setup from the new checkout:

```sh
codex plugin remove swe2-bridge@swe2-bridge-local
codex plugin marketplace remove swe2-bridge-local
npm ci --ignore-scripts
npm run doctor
npm run install:local
```

Use the Codex executable path reported by the doctor if `codex` is not on `PATH`. These registration changes leave the old source clone and job history in place.

To remove the installation when `codex` is on `PATH`:

```sh
codex plugin remove swe2-bridge@swe2-bridge-local
```

If Codex is bundled in the desktop app, use the executable path reported by the doctor. You can also disable or uninstall this plugin through Codex's plugin UI. The removal command does not delete the source clone, staged marketplace, or job history. Confirm no bridge jobs are active before deleting generated files. State under `~/.local/share/devin-bridge` may contain sensitive material; delete it only when you no longer need it for review or recovery.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Node, Git, Codex, or Devin not found | Run `npm run doctor`; install the missing prerequisite or set its supported path override. |
| Codex has no `plugin` command | Use a Codex build that supports local plugins. Do not claim the install succeeded. |
| Tools missing in an existing task | Confirm the plugin is enabled, then start a fresh Codex task. |
| MCP tool requires approval but the host policy is `never` | Authorize the scoped invocation through Codex's normal permission controls. For an already-authorized unattended test, `codex exec --approve-for-me` uses normal automatic review. The bridge cannot grant its own host approval. |
| Marketplace already registered from another source | Follow the relocation steps above to replace this plugin's old registration, then reinstall. |
| `AUTH_REQUIRED` | Complete Devin's normal login locally, then assess whether to retry. |
| Model unavailable or unverified | Check your Devin account and exact model ID. Do not silently substitute a different model. |
| `WORKSPACE_TRUST_REQUIRED` | Review the exact assignment directory, then use native trust or an explicit caller acknowledgment for that assignment. |
| `needs_permission` or `needs_input` | Inspect `pending_requests`; approve only an offered allowed check, deny, or answer the bounded requested form with `devin_respond`. |
| `WORKER_CAPACITY` or `WORKSPACE_BUSY` | Wait for or cancel the owning job; inspect interrupted work before retrying. Do not delete a lock to force concurrent execution. |
| `ACP_REMOTE_ERROR`: session is already open in another process | Release that session in its owning Devin desktop or CLI client. A completed bridge turn does not prevent another client from opening the same session. Inspect the blocked job, then use an explicit next-revision `devin_message` with partial-work acknowledgment; repeating the same revision returns its existing job. See [session ownership](WORKER_CONTRACT.md#follow-ups-and-recovery). |
| `ASSIGNMENT_CONFLICT` | The ID/revision names different work. Discover the existing job and use an explicit consecutive follow-up revision. |
| `PARTIAL_WORK_REVIEW_REQUIRED` | Inspect the previous result and workspace before acknowledging partial work in `devin_message`. |
| Interrupted, timed-out, or unverified result | Inspect the result, private artifacts, and workspace. Partial changes remain; rerunning a task can repeat them. |

Report reproducible issues with sanitized versions, commands, expected behavior, and results. Do not attach raw session artifacts, prompts containing project data, credentials, or entire state directories.
