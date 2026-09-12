# Agent setup guide

Use this workflow when a user asks you to install SWE2 bridge locally. Treat the request as authorization for ordinary dependency installation and local plugin setup. Continue through those steps without repeated permission questions. A setup request alone does not authorize submitting an inference task, changing global trust/permissions, purchasing a subscription, or discarding existing work.

The bridge adds a Devin worker alongside native Codex agents. Preserve the user's existing model-selection and delegation rules. Do not introduce routing priorities or edit global agent instructions during setup.

## 1. Inspect the environment

Read the repository's `AGENTS.md`, `README.md`, and `docs/LOCAL_SETUP.md`. Identify the existing checkout and preserve its changes. If no checkout exists, clone the public repository into a normal user-owned workspace:

```sh
git clone https://github.com/naim149/swe2-bridge.git
cd swe2-bridge
```

Run read-only prerequisite checks:

```sh
uname -s
node --version
npm --version
git --version
```

Proceed on macOS. On Linux, disclose that the platform is unverified and use `--experimental-linux` only when the user has chosen that experimental setup. Stop on Windows: this version relies on POSIX process groups and has no Windows implementation.

Use installed binaries or the documented path overrides. Do not download a substitute named `devin`, execute an unrelated application, or assume an alias resolves to the intended CLI.

## 2. Install dependencies and inspect prerequisites

```sh
npm ci --ignore-scripts
npm run doctor -- --json
```

For an explicitly chosen Linux experiment, add `--experimental-linux` to the doctor's arguments. The doctor does not submit inference work. Resolve ordinary local prerequisites within the user's authorization. If `npm ci` or the doctor fails, report the actual command and error; do not call the installation complete.

For an existing modified checkout, do not use `git reset`, `git clean`, or overwrite files to make setup pass. If a prerequisite needs user action, complete independent setup work and state the smallest remaining action.

## 3. Check Devin authentication and model access

Use the Devin executable identified by the doctor. With `devin` on `PATH`:

```sh
devin auth status
devin models list --format json
```

If login is required, launch its normal flow:

```sh
devin auth login
```

An interactive browser, account-choice, Keychain, or approval prompt may require the user. Pause only the dependent step, describe the prompt, and resume after it is completed. Never read or print credential files, request a password/token in chat, or impersonate the user's account choice. Do not purchase account access or silently choose another model.

The default model is `swe-2-medium`. Check the exact model requested by the user against the live account catalog. Authentication and catalog visibility establish prerequisites; they are not proof of a successful model invocation.

## 4. Install the local plugin

On macOS:

```sh
npm run install:local
```

For an explicitly chosen Linux experiment:

```sh
npm run install:local -- --experimental-linux
```

The installer creates the generated runtime under `.local/marketplace/plugins/swe2-bridge`, registers `swe2-bridge-local`, and runs the Codex plugin installation command. Inspect its result rather than inferring success from generated files alone. Do not commit the generated directory or machine-specific paths.

Keep the source checkout in place. If another copy of this plugin is already installed under a personal marketplace, explain the duplicate and resolve the intended installation without removing unrelated plugins. Do not rewrite global routing rules or add a native Codex model-picker entry.

If moving an existing `swe2-bridge-local` installation to this checkout, stop active bridge jobs and follow the relocation commands in `docs/LOCAL_SETUP.md`. Codex rejects registering the same marketplace name from a different source until its old registration is removed. Remove only this plugin and its marketplace registration; preserve the previous source checkout and job history.

## 5. Verify discovery in a fresh task

Start a fresh Codex task/session after installation if the user's request includes doing so. Otherwise tell the user to open a fresh task; do not create an unsolicited persistent task. Verify that the installed skill and the tools `devin_run`, `devin_wait`, and `devin_cancel` are discoverable. Prefixes in the tool names may depend on Codex's MCP namespace.

Discovery is separate from inference. If the user asked only for setup, stop verification here and report that a real model task has not been run.

## 6. Run a bounded real check when authorized

If the user authorized real testing, follow the disposable fixture procedure in [LOCAL_SETUP.md](LOCAL_SETUP.md). Use no private project data, honor Devin's workspace trust, and retain normal permission settings. A directory created and reviewed for this check can be trusted specifically through Devin's normal flow; do not bypass trust globally.

Call the real tools once per intended task:

1. `devin_run` with an absolute fixture path, explicit model, bounded objective, constraints, acceptance criteria, and short deadline.
2. Save the `job_id`; collect progress with `devin_wait` in waits of at most 30 seconds. Continue useful independent work between waits.
3. Use `devin_cancel` when the test should stop. Cancellation preserves partial changes.
4. Check the final answer and workspace independently. A terminal process status does not establish task acceptance.

On authentication, model access, trust, or permission errors, report the cause and stop the dependent test. Do not silently resubmit a mutating task or change models/permissions. On timeout, interruption, or uncertain completion, inspect the existing job and partial changes before deciding whether a retry is safe.

In the default `accept-edits` mode, shell, build, and test commands can require approval that cannot be granted through these headless tools. Do not report worker verification as performed when a command was blocked, even if the CLI process exited successfully.

Do not write a mock test suite as a substitute for checking the actual integration. Run additional real scenarios only when they address changed behavior or a specific unresolved concern.

## 7. Report the result

Return a concise handoff containing:

- The source path, local plugin name, and whether installation was confirmed.
- OS, Node, Codex, and Devin CLI versions checked, without credentials or account identifiers.
- Discovery status and the need for a fresh Codex task if discovery was not checked there.
- Real checks performed, exact model used, pass/fail, and any block or untested area.
- A link to the local setup guide for updates and removal.

Keep raw prompts, exports, logs, diffs, and job records private. Public reports should contain a sanitized reproduction and only the minimal evidence needed to assess it.
