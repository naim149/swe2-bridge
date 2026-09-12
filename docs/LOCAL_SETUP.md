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

Confirm that the model you intend to use is available. The bridge defaults to `swe-2-medium`; access depends on your Devin account. Listing models and being logged in do not by themselves establish that a real inference request will succeed.

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

Existing tasks can retain an older set of tools. Start a new task after installation or update, then ask it to use the Devin worker. The plugin exposes `devin_run`, `devin_wait`, and `devin_cancel`, plus the `devin` skill. The UI may prefix tool names with the MCP server name.

The worker is available alongside native agents. Existing user rules decide when to use it; installation does not rewrite those rules or add a native model-picker option.

The default `accept-edits` mode does not guarantee unattended shell access. Shell, build, and test commands can require interactive approval that the headless bridge cannot grant. A blocked task needs its requested action reviewed through Devin's normal workflow or a revised assignment.

## 5. Optional real acceptance check

This step submits a real Devin model task. Run it only when you intend to use the account for that purpose. Setup can finish before a live check.

Create a disposable Git fixture with no project data:

```sh
bridge_fixture="$(mktemp -d "${TMPDIR:-/tmp}/swe2-bridge-check.XXXXXX")"
git init "$bridge_fixture"
printf '%s\n' 'bridge-check-7d92' > "$bridge_fixture/probe.txt"
printf '%s\n' "$bridge_fixture"
```

Open Devin in that directory and make its normal workspace-trust decision. Trust only the directory you created and reviewed. Do not change global trust or permission settings for a smoke check.

In a fresh Codex task, substitute the printed absolute path:

> Use `devin_run` once with model `swe-2-medium`, cwd `/absolute/path/to/the/fixture`, and a 120-second timeout. Read `probe.txt` and return its exact contents. Do not edit files, execute shell commands, use network tools, or work outside the fixture. Use `devin_wait` with the returned job ID to collect the result. Verify the marker and check that the file is unchanged. If authentication, model access, trust, or permissions block the run, report the block and stop; do not change settings or resubmit it automatically.

Pass criteria: the tool starts one job, the final answer contains `bridge-check-7d92`, the requested/resolved model is reported, and the file remains unchanged. A job can finish but fail these task criteria.

For an edit check, create a separate disposable fixture with a deliberately incorrect small function and pre-existing tracked and untracked changes. Give the worker ownership of only that function; inspect its diff, evaluate the corrected result, and confirm the other files are unchanged. Cancellation, deadlines, concurrency, and recovery checks are described in [CONTRIBUTING.md](../CONTRIBUTING.md); they are useful for changes to the runner, not required for every installation.

## Configuration

The installer records environment overrides in the generated `.mcp.json` under the ignored staged plugin, not in public source. Node's executable path is resolved during setup. Set overrides in your shell before `npm run install:local` and supply the same intended configuration when reinstalling.

| Variable | Behavior |
| --- | --- |
| `CODEX_CLI_PATH` | Optional Codex executable override used by setup. |
| `DEVIN_CLI_PATH` | Explicit Devin executable path. Otherwise resolves `devin` on `PATH`, then the known macOS app location. |
| `DEVIN_BRIDGE_MODEL` | Default `swe-2-medium`; a `devin_run` `model` argument overrides it for that job. |
| `DEVIN_BRIDGE_STATE_DIR` | Default `~/.local/share/devin-bridge`; stores prompts, logs, exports, job state, snapshots, and locks. |
| `DEVIN_BRIDGE_PERMISSION_MODE` | Default `accept-edits`, passed to Devin. Use the permissions appropriate for your work. |
| `DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST` | Default `true`. Keep workspace trust enabled for normal use. |

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

Start a fresh Codex task after the reinstall. If the clone contains local changes, resolve them before pulling; do not discard them as part of setup.

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
| Marketplace already registered from another source | Follow the relocation steps above to replace this plugin's old registration, then reinstall. |
| `AUTH_REQUIRED` | Complete Devin's normal login locally, then assess whether to retry. |
| `MODEL_ACCESS_BLOCKED` | Check your Devin account and exact model ID. Do not silently substitute a different model. |
| `WORKSPACE_UNTRUSTED` | Review and trust that specific directory through Devin's normal flow. |
| `PERMISSION_REQUIRED` | Review the requested action and handle it through the normal interactive workflow or revise the assignment. Do not globally bypass permissions. |
| `WORKER_BUSY` or `WORKSPACE_BUSY` | Wait for or cancel the owning job; inspect interrupted work before retrying. Do not delete a lock to force concurrent execution. |
| Interrupted, timed-out, or unverified result | Inspect the result, private artifacts, and workspace. Partial changes remain; rerunning a task can repeat them. |

Report reproducible issues with sanitized versions, commands, expected behavior, and results. Do not attach raw conversation exports, prompts containing project data, credentials, or entire state directories.
