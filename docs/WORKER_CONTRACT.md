# Worker contract

Version 0.2 makes Devin an additional session-based worker in an existing orchestration graph. The Lead selects workers using the caller's current task, role, and model rules. The bridge adds no selection priority, routing tier, or native Codex model-picker entry.

This document describes the implemented contract. Consult [VERIFICATION.md](../VERIFICATION.md) for observed results and qualification gaps.

## Assignment identity and source

An assignment has an `assignment_id` and consecutive `revision`, starting at 1. Use a stable ID for a particular piece of work. The bridge persists the identity before inference. Repeating the same ID/revision with identical normalized intent returns the recorded job with `deduplicated: true`; it does not submit the prompt again. Different work under the same ID/revision returns `ASSIGNMENT_CONFLICT`.

Each revision has its own `job_id`. A finished turn can receive a deliberate `devin_message` follow-up at the next revision. It returns a new job linked by `previous_job_id`, retains the assignment identity, and loads the same Devin session. Follow the new job ID. An optional ID is generated when omitted, but omitting it on repeated `devin_run` calls does not provide deduplication.

Use the canonical checkout root as `cwd`. Supply an exact 40- or 64-character Git commit ID as `base_sha` when the expected source revision matters; obtain the actual value from that checkout. The bridge checks it during readiness and again before prompt submission. A branch name or moving alias is not a base SHA. Existing dirty work is preserved and included in the initial evidence.

## Assignment fields

| Field | Meaning |
| --- | --- |
| `task`, `cwd` | Bounded objective/context and an absolute existing working directory. |
| `assignment_id`, `revision` | Stable work identity and consecutive revision; initial revision defaults to 1. |
| `model` | Exactly `swe-2-medium`, `swe-2-high`, or `swe-2-max`; default `swe-2-medium`. |
| `role`, `scope` | Existing orchestration role and additional assignment constraints. |
| `base_sha` | Optional exact expected Git HEAD. |
| `profile`, `owned_paths` | Execution policy and literal owned files/directories. |
| `checks` | Exact verification commands, directories, execution owners, deadlines, and approval policy. |
| `acceptance` | Criteria with IDs, descriptions, and references to declared check IDs. |
| `resources` | Namespaced shared resources and their owners. |
| `attachments` | Bounded local PNG/JPEG/WebP or UTF-8 text references. |
| `workspace_trust`, `trust_reason` | Existing native trust or the caller's acknowledgment for this exact directory. |
| `timeout_seconds` | Per-turn deadline, 1–3600 seconds; default 900. |

`devin_preflight` takes the same assignment as `devin_run` and submits no inference. It checks account authentication, live model catalog visibility, source assumptions, trust, attachment readiness, and policy. Catalog presence does not guarantee successful inference. The real session must also support the required input capabilities and confirm the selected model.

## Profiles, owned paths, and checks

| Profile | Delegated filesystem writes | Shell checks |
| --- | --- | --- |
| `read` | Denied; Devin session uses `ask` mode. | Denied; use native verification if needed. |
| `edit` | Allowed only for `owned_paths`; session uses `accept-edits`. | Native-executor handoff. |
| `edit_check` | Allowed only for `owned_paths`; session uses `accept-edits`. | Exact declared commands assigned to Devin. |

`owned_paths` is required for both edit profiles. Entries are literal repository-relative files, such as `src/parser.mjs`, or directory prefixes ending in `/`, such as `src/parser/`. Globs, absolute paths, traversal, and `.git` ownership are rejected. Delegated text reads/writes are bounded; ownership is checked after canonicalizing paths.

A check declares an `id`, exact `command`, optional absolute `cwd` inside the assignment directory, optional `owner`, `timeout_seconds` (1–600; default 60), and `approval` (`automatic` or `ask`; default `automatic`). The bridge terminal handlers enforce the actual command and canonical cwd together, including declared subdirectories. A differently worded command, a different directory, separate argument/environment overrides, or another executor's check is not equivalent authorization.

Copy a declared command byte-for-byte into the execution request. Do not prepend `cd`, wrap it in another shell, or combine it with another command. Pass the declared cwd separately when supported; if the CLI tool cannot express it without changing the command, return the exact native-executor handoff.

With `edit_check`, `owner: "devin"` or an omitted owner lets Devin request that exact check. A different owner creates a native handoff. `approval: "automatic"` is the caller's declaration that this check may execute; `ask` creates a one-time decision at execution. Review the command before authorizing it: exact matching does not restrict what that command can do under the OS account.

## Generic integration example

Suppose the Lead selected Devin to fix a parser while a native verifier owns a package-wide check. Substitute the real checkout path and current HEAD before calling `devin_preflight`:

```json
{
  "assignment_id": "parser-empty-input-01",
  "revision": 1,
  "role": "implementer",
  "task": "Fix empty input handling in the parser. Preserve the public API and unrelated changes. Report the implementation and checks actually performed.",
  "cwd": "/absolute/project/worktree",
  "base_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "model": "swe-2-medium",
  "profile": "edit_check",
  "owned_paths": ["src/parser.mjs"],
  "checks": [
    {
      "id": "parser-tests",
      "command": "node --test test/parser.test.mjs",
      "cwd": "/absolute/project/worktree",
      "owner": "devin",
      "timeout_seconds": 60,
      "approval": "automatic"
    },
    {
      "id": "package-types",
      "command": "npm run typecheck",
      "cwd": "/absolute/project/worktree",
      "owner": "native-verifier",
      "timeout_seconds": 120
    }
  ],
  "acceptance": [
    {
      "id": "empty-input",
      "description": "Empty input returns the existing documented empty result without breaking parser tests.",
      "check_ids": ["parser-tests"]
    },
    {
      "id": "types",
      "description": "The package type check succeeds.",
      "check_ids": ["package-types"]
    }
  ],
  "resources": [{"name": "build:package", "owner": "native-verifier"}],
  "workspace_trust": "inherit",
  "timeout_seconds": 900
}
```

After readiness passes, pass that same object to `devin_run`. Save `job_id`, `assignment_id`, `revision`, and the returned cursor. The example check files/commands must actually exist in the target project; declaring a command does not create it or establish that it passed.

The external pool allows 1–3 jobs (default 3) across bridge instances sharing a state directory. The Lead separately counts native plus external workers under the caller's existing budget. For example, if the caller allows three concurrent workers and two native workers are active, only one external slot fits that budget even if the bridge advertises three free slots.

Concurrent bridge jobs require independent checkouts; the same canonical checkout is locked even for disjoint files. Resource names use a namespace, such as `build:package` or `device:simulator-1`. Resources assigned to `devin` are locked across bridge jobs sharing state. Resources owned by native agents remain an orchestration responsibility; the bridge does not reserve devices or control those agents.

## Progress and attention

Call `devin_wait` with `job_id`, `after_cursor` (initially 0), and `wait_seconds` (0–30; default 10). Pass the returned `next_cursor` as the next `after_cursor`. If `events_remaining` is true, drain the next page. `cursor_gap` indicates that earlier events are no longer retained. `devin_wait_many` accepts 1–32 distinct job/cursor pairs and returns a separate result for each.

`devin_list` discovers persisted jobs and optionally filters by assignment ID. Its `next_cursor` is an opaque pagination token, separate from each job's numeric event cursor. Listing is for recovery, not a signal to rerun work.

`needs_permission` and `needs_input` are attention states. Inspect each `pending_requests` item and its `request_id`:

- For an offered declared check with `approval_allowed: true`, use `devin_respond` with `decision: "approve_once"` or `"deny"`. Undeclared or ambiguous commands cannot be approved; deny and amend the assignment at a later revision or use a native executor.
- For a form request, use `decision: "answer"` and an `answers` object matching the requested schema's declared string fields and choices. Use the caller's existing context, or ask for required missing information. Unsupported forms are declined; do not invent an answer merely to advance the job.

For example, after reviewing an actual pending allowed request:

```json
{"job_id":"<returned-job-id>","request_id":"<pending-request-id>","decision":"approve_once"}
```

Permission/input responses are recorded. Repeating an identical response can recover its result; changing an already recorded decision returns a conflict. A worker waiting for attention still occupies its slot and remains subject to its deadline.

The optional `note` is a **local audit explanation only**: it is stored in the job's response artifact and is not sent to Devin. Do not put instructions, corrected paths, or source references there expecting the worker to receive them. To convey that context, wait for the current turn to finish, inspect any partial work, and send an explicit `devin_message` with the next revision as described below. Include `acknowledge_partial_work: true` when the prior turn did not complete. A note grants no additional permission.

## Follow-ups and recovery

Once a turn has finished, continue the same session with the next consecutive revision:

```json
{
  "job_id": "<revision-1-job-id>",
  "revision": 2,
  "task": "Address the review finding about whitespace-only input. Preserve the previous fix and rerun the declared parser check."
}
```

Send this object to `devin_message`, then follow the **new** job ID it returns. Omitted `owned_paths` and `checks` preserve the prior assignment. Omitted `base_sha` uses the prior observed after-HEAD when available, otherwise the previous source expectation; inspect source assumptions before continuation. Attachments default to none for the new message and must be explicitly supplied when needed. Model, execution profile, resources, and acceptance remain the assignment's existing values.

Cancel with `devin_cancel` when work should stop. Timeout, cancellation, interruption, and incomplete results preserve changes. Before continuing any non-completed turn, inspect the workspace/evidence and explicitly set `acknowledge_partial_work: true` in the follow-up. This is acknowledgment of reviewed work, not permission to discard it.

After a bridge restart, use `devin_list`/`devin_wait` to discover work. No prompt is automatically replayed. If an owner exited, cancellation can reconcile verified surviving processes; uncertain process identity keeps its locks for inspection. A job without a verified ACP session, including a legacy version 0.1 job, cannot be resumed. Resolve its blocker and inspect its state before deliberately assigning further work.

Devin permits only one ACP process to hold a session at a time. Devin desktop or another CLI client can open it between completed bridge turns, causing a follow-up to return `ACP_REMOTE_ERROR` with an "already open in another process" message. Release the session through that owning client, inspect the blocked job, then send an explicit consecutive revision with `acknowledge_partial_work: true`. Repeating the blocked revision returns its existing job. The bridge does not close another client's session or automatically retry the prompt. A leftover Devin PID file alone does not establish that its owner is still running; do not delete it to force a resume.

## Verification and acceptance

A worker turn ending is not task acceptance. Review the final answer, scope status, changed files, source evidence, blockers, and each check. `task_accepted` remains false. Incomplete evidence or output must not become a clean-success claim.

For checks executed through bridge terminals, evidence records the command, actual cwd, process/exit status, timing, source snapshot hashes, and bounded output artifacts. A later observed source change marks passed proof `stale`; changed or missing source during the check leaves proof `unknown`. The historical exit code is retained. A native handoff remains unrun until the named executor does the work. After the turn finishes, record that actual result with `devin_record_check`:

```json
{
  "job_id": "<returned-job-id>",
  "check_id": "package-types",
  "status": "passed",
  "command": "npm run typecheck",
  "exit_code": 0,
  "cwd": "/absolute/project/worktree",
  "source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifact_paths": ["/absolute/private/evidence/typecheck.log"],
  "executor": "native-verifier"
}
```

A passed record requires an explicit zero exit code; referenced artifacts must be actual local files. If supplied, `cwd` must match the declared check directory and `source_sha` must match the job's recorded after-HEAD; substitute the real tested value in the example. Omitted source SHA leaves source provenance unknown. The record remains caller-reported, not independently executed or attested by the bridge. Evaluate the evidence against the linked acceptance criteria yourself.

## Boundaries and known limits

- No whole-OS sandbox is provided. Delegated file handlers enforce their contract, but built-in Devin tools such as search may bypass them, and an authorized shell command retains the OS account's access. Scope is not a confidentiality boundary.
- Git evidence covers visible worktree, index, and HEAD differences. Ignored files, external paths, transient changes reverted before inspection, and some submodule contents are not fully observed. Differences do not prove which process made them. Non-Git workspaces have no Git ownership proof.
- Output and events are bounded. Inspect `output_truncated`, `cursor_gap`, `events_remaining`, and evidence completeness; an absent event or empty visible diff is not proof nothing happened.
- Attachments embed authorized local content, not remote URLs or the caller's entire conversation. Limits are eight attachments, 4 MiB per supported image, 1 MiB per UTF-8 text file, and 8 MiB of raw attachments in total. The entire serialized prompt also has an 8 MiB transport budget after base64 encoding, with 8 KiB reserved for framing; this can require smaller images than the raw limits allow. CLI text file handlers are limited to 2 MiB per file. Actual session capabilities must support the requested input types.
- Codex tools, browsers, devices, other agents, credentials, and permission to deploy/sign/publish are not inherited. A resource or attachment declaration does not grant those capabilities.
- Check evidence, session records, prompts, form answers, and diffs can be sensitive. Keep raw artifacts private; see [SECURITY.md](../SECURITY.md).

These limits are part of the contract even when a particular smoke check passes. Expand reliability claims only after relevant real-environment evidence is recorded.
