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

Accept only `swe-2-medium`, `swe-2-high`, or `swe-2-max`; the default is `swe-2-medium`. Check the user's exact selection against the live account catalog. Authentication and catalog visibility establish prerequisites; they are not proof of a successful model invocation.

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

Start a fresh Codex task/session after installation if the user's request includes doing so. Otherwise tell the user to open a fresh task; do not create an unsolicited persistent task. Verify the `devin` skill and all nine tools: `devin_preflight`, `devin_run`, `devin_message`, `devin_wait`, `devin_wait_many`, `devin_list`, `devin_respond`, `devin_cancel`, and `devin_record_check`. Prefixes may depend on Codex's MCP namespace.

Discovery is separate from inference. `devin_preflight` can inspect a bounded assignment without a model task, including exact model catalog visibility, source assumptions, trust, and attachment readiness. If the user asked only for setup, finish with discovery/preflight and report that real inference has not been checked.

## 6. Run a bounded real check when authorized

If the user authorized real testing, follow the disposable fixture procedure in [LOCAL_SETUP.md](LOCAL_SETUP.md) and the [worker contract](WORKER_CONTRACT.md). Use no private project data. Establish trust for the exact directory through native trust or an explicit assignment acknowledgment after review; do not change global settings.

Codex host permission for an MCP invocation is separate from Devin's scoped check decisions. Use the host's normal approval controls for the authorized task. An unattended Codex invocation with a required approval and policy `never` stops before a job exists; `codex exec --approve-for-me` can route an authorized fixture invocation through normal automatic review.

Call the real tools once per intended task:

1. Create a structured assignment with a stable `assignment_id`, revision 1, absolute fixture path, exact model, execution profile, ownership/check policy, acceptance criteria, and short deadline.
2. Run `devin_preflight`, then use the same ready assignment with `devin_run`. Save its `job_id`; never change the identity merely to force a retry.
3. Collect progress with `devin_wait` or `devin_wait_many` in waits of at most 30 seconds. Pass each job's returned `next_cursor` back as `after_cursor` and inspect cursor gaps/truncation.
4. Respond to permitted attention requests with `devin_respond`. Undeclared commands require an amended assignment or native handoff; form answers must match the requested fields.
5. Use `devin_cancel` when work should stop. Inspect partial changes before an explicit `devin_message` follow-up. A follow-up returns a new job ID in the same assignment/session at the next revision.
6. Check the answer, workspace, and verification independently. Record native checks with `devin_record_check` only after they actually ran; include the actual cwd and recorded after-HEAD as `source_sha` when known. Omitted source SHA leaves source provenance unknown, and the record never proves the bridge independently executed the check.

On authentication, model access, or trust errors, report the cause and stop the dependent test. Do not silently resubmit a mutating task or change models/permissions. Use `devin_list` to recover existing work. After timeout, interruption, or uncertain completion, inspect the job and workspace before setting `acknowledge_partial_work: true` on a deliberate next revision.

The Lead counts native and external workers against its existing budget; the external shared pool has its own maximum of three. Use independent checkouts for concurrent jobs and coordinate named resources. `owned_paths` restrict delegated writes, while `edit_check` permits exact declared shell checks. These controls do not form an OS sandbox or prove that built-in CLI search obeys the bridge's read handlers.

Run `npm run check` and `npm test` for local source/regression verification; they do not submit inference. These checks complement real integration evidence. Run additional live scenarios when they address changed behavior or a specific unresolved concern, and state which results are still pending.

## 7. Report the result

Return a concise handoff containing:

- The source path, local plugin name, and whether installation was confirmed.
- OS, Node, Codex, and Devin CLI versions checked, without credentials or account identifiers.
- Discovery status and the need for a fresh Codex task if discovery was not checked there.
- Real checks performed, exact model used, pass/fail, and any block or untested area.
- A link to the local setup guide for updates and removal.

Keep raw prompts, exports, logs, diffs, and job records private. Public reports should contain a sanitized reproduction and only the minimal evidence needed to assess it.
