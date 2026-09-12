# Worker contract

Devin is an additional session-based worker in an existing orchestration graph. Version 0.3 extends the version 0.2 assignment contract with optional prepared reviews, quiet waits, and durable reports. The Lead selects workers using the caller's current task, role, and model rules. The bridge adds no selection priority, routing tier, or native Codex model-picker entry.

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
| `review` | Optional immutable comparison `{base_sha, head_sha}` for a `read` assignment; distinct from checkout HEAD. |
| `profile`, `owned_paths` | Execution policy and literal owned files/directories. |
| `checks` | Exact verification commands, directories, execution owners, deadlines, and approval policy. |
| `acceptance` | Criteria with IDs, descriptions, and references to declared check IDs. |
| `resources` | Namespaced shared resources and their owners. |
| `attachments` | Bounded local PNG/JPEG/WebP or UTF-8 text references. |
| `workspace_trust`, `trust_reason` | Existing native trust or the caller's acknowledgment for this exact directory. |
| `timeout_seconds` | Per-turn deadline, 1–3600 seconds; default 900. |

`devin_preflight` takes the same assignment as `devin_run` and submits no inference. It checks account authentication, live model catalog visibility, source assumptions, trust, attachment readiness, and policy. Catalog presence does not guarantee successful inference. The real session must also support the required input capabilities and confirm the selected model.

## Prepared Git reviews

When assigning a commit or PR review, resolve the intended base and head with the Lead's existing Git/repository capabilities, then supply their full immutable commit IDs. The bridge does not infer a PR's merge base, fetch missing objects, or treat a moving branch name as the comparison. Add the following field to a `read` assignment:

```json
{
  "review": {
    "base_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

Substitute real 40- or 64-character commit IDs. The outer assignment `base_sha` still asserts the current checkout HEAD; it need not equal either comparison commit. `review.base_sha` and `review.head_sha` define a direct two-commit comparison. Dirty files and the current checkout are separate observations and never replace those immutable inputs.

Preparation reads local Git objects and embeds the actual diff, every changed path with old/new blob identity, and applicable tracked `AGENTS.md` content from the comparison head. Root and nested instructions cover changed, renamed, and deleted paths; no working-tree or base-revision instructions are silently substituted. Caller and higher-priority instructions still apply. The packet uses Git with external diff/text conversion disabled and requires support for `--attr-source` so attributes come from the comparison head.

Review preparation and its before/after workspace snapshots disable configured hooks, filesystem monitors, conversion filters, and implicit fetches. Local custom function-header settings are disabled and optional hunk function labels are removed so they cannot shape the immutable diff. Snapshot reads skip submodule interiors; if submodules or disabled conversion filters reduce normal observation, workspace evidence remains incomplete. That workspace limitation is separate from whether the two-commit packet itself is complete. Assignments without `review` retain their existing snapshot behavior.

Successful preflight returns `review.complete: true`, `comparison_id`, `packet_sha256`, coverage, limits, and the comparison identities. The packet hash covers immutable evidence; `content_sha256` also covers the separately labeled checkout observations included in the submitted content. Submission prepares the evidence again and rejects a changed immutable packet. The job persists its review identity and the actual submitted content in private artifacts.

If comparison objects are missing, not commits, identical in tree content, unsupported, or over budget, preflight returns `ready: false` with `review.complete: false` and a specific blocker before any model task. No partial packet is accepted. The initial text-review limits are:

| Evidence | Limit |
| --- | --- |
| Changed paths | 128 |
| Each changed blob | 256 KiB; 4 MiB total unique blobs inspected |
| Complete diff | 512 KiB, with three lines of context |
| Applicable instructions | 64 files; 64 KiB each; 256 KiB total |
| Serialized packet | 1 MiB |
| Preparation | 20 seconds total, with bounded individual Git commands |

Binary or invalid UTF-8 content, Git LFS pointers, changed gitlinks/submodules, non-regular applicable instruction files, and partial/promisor clones are rejected. Additional path and metadata limits are reported in `review.limits`. Materialize missing objects separately, or deliberately scope another comparison; do not describe omitted work as reviewed.

`complete` describes the bounded comparison packet, not a complete repository snapshot or proof of correctness. Full unchanged context and complete changed-file bodies are not embedded. If the reviewer needs more semantic context, supply authorized references or return a specific limitation before claiming full coverage. Review preparation grants no worker-facing Git/history tools, shell execution, edits, or network access; `read` profile restrictions remain in force.

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

The external pool allows 1–4 jobs (default 4) across bridge instances sharing a state directory. The Lead separately counts native plus external workers under the caller's existing budget. For example, if the caller allows four concurrent workers and one native worker is active, only three external slots fit that budget even if the bridge advertises four free slots.

Concurrent bridge jobs require independent checkouts; the same canonical checkout is locked even for disjoint files. Resource names use a namespace, such as `build:package` or `device:simulator-1`. Resources assigned to `devin` are locked across bridge jobs sharing state. Resources owned by native agents remain an orchestration responsibility; the bridge does not reserve devices or control those agents.

## Progress and attention

Call `devin_wait` with `job_id`, `after_cursor` (initially 0), and `wait_seconds` (0–55; default 10). The default `mode: "progress"` preserves normal transcript delivery. Pass the returned `next_cursor` as the next `after_cursor`. If `events_remaining` is true, drain the next page. `cursor_gap` indicates that earlier events are no longer retained. `devin_wait_many` accepts 1–32 distinct job/cursor pairs and returns a separate result for each.

Opt into `mode: "quiet"` when you need a compact wait for a new terminal outcome or actionable pending request. Ordinary progress events do not wake that wait. It also returns on an error or the bounded timeout. The response includes compact job state, `next_token`, `changed`, and `wake_reason`; it omits transcript events and the ordinary cumulative summary. A changed terminal state includes a bounded final handoff and a durable artifact reference. A terminal state already acknowledged by its token omits that repeated handoff.

`wake_reason` explains why the call returned (`terminal`, `attention`, or `timeout`; a multi-job load failure uses `error`). `changed` means the compact state differs from the acknowledged token, so a first active snapshot can have `changed: true` with `wake_reason: "timeout"`. Later recorded verification or other final-report evidence changes invalidate a terminal token. Event-only progress does not.

Keep the two acknowledgment mechanisms separate:

| Value | Purpose |
| --- | --- |
| `after_cursor` / `next_cursor` | Transcript delivery position. Quiet leaves `next_cursor` equal to the supplied `after_cursor`, so no events are consumed. |
| `cursor` | Latest server event position, which may advance during a quiet wait. Do not use it to skip unseen transcript events. |
| `after_token` / `next_token` | Acknowledgment of one job's compact state. Tokens are opaque 64-character lowercase hexadecimal values. |

For a first quiet wait, omit `after_token`. After handling its result, pass that job's returned `next_token` as `after_token` on the next quiet wait. Keep the previous transcript cursor unchanged. For example:

```json
{
  "job_id": "<returned-job-id>",
  "mode": "quiet",
  "after_cursor": 0,
  "wait_seconds": 55
}
```

For `devin_wait_many`, set `mode` on the whole call and put each `after_token` inside its matching `jobs[]` item alongside `after_cursor`. After the first response, substitute each actual returned token in the next call:

```json
{
  "mode": "quiet",
  "wait_seconds": 55,
  "jobs": [
    {
      "job_id": "<first-job-id>",
      "after_cursor": 0,
      "after_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "job_id": "<second-job-id>",
      "after_cursor": 0,
      "after_token": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ]
}
```

Remove completed jobs from a continuing wait set, or acknowledge their returned terminal token. Leaving a terminal state unacknowledged causes it to be delivered again. Acknowledging attention means it has been seen; it does not answer the request. Handle `needs_permission`/`needs_input` with `devin_respond` as described below. Use progress mode from the preserved transcript cursor, or inspect the durable artifact records, when you need full diagnostics. Quiet mode retains truthful `cursor_gap` and truncation indicators; compact output does not erase missing evidence.

Cancelling a wait stops only that wait, leaving its worker running. The manager rejects internally with `WAIT_CANCELLED`; MCP suppresses the cancelled response, so the caller receives its SDK/host cancellation result instead of a tool payload with that code. A closing manager reports `BRIDGE_CLOSED` when the transport can still deliver it. Use `devin_cancel` to cancel the job. The plugin's MCP tool timeout is 75 seconds to allow the maximum 55-second wait plus transport and cleanup overhead.

On the qualified Codex host, steering a model turn during a held wait was queued until the call finished; explicit turn interruption returned promptly and left the worker running. Shorter waits remain available when that steering delay matters. These are bounded request/response waits, with no promise of a background agent wakeup or automatic resumption after the caller's turn ends. See [host qualification](../VERIFICATION.md) for measured behavior and its limits.

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

Send this object to `devin_message`, then follow the **new** job ID it returns. Omitted `owned_paths`, `checks`, and `review` preserve the prior assignment. Supply a new explicit `review` pair to review another comparison; it is never inferred from a moved checkout. Omitted `base_sha` uses the prior observed after-HEAD when available, otherwise the previous source expectation; inspect source assumptions before continuation. Attachments default to none for the new message and must be explicitly supplied when needed. Model, execution profile, resources, and acceptance remain the assignment's existing values.

Cancel with `devin_cancel` when work should stop. Timeout, cancellation, interruption, and incomplete results preserve changes. Before continuing any non-completed turn, inspect the workspace/evidence and explicitly set `acknowledge_partial_work: true` in the follow-up. This is acknowledgment of reviewed work, not permission to discard it.

After a bridge restart, use `devin_list`/`devin_wait` to discover work. No prompt is automatically replayed. If an owner exited, cancellation can reconcile verified surviving processes; uncertain process identity keeps its locks for inspection. A job without a verified ACP session, including a legacy version 0.1 job, cannot be resumed. Resolve its blocker and inspect its state before deliberately assigning further work.

Devin permits only one ACP process to hold a session at a time. Devin desktop or another CLI client can open it between completed bridge turns, causing a follow-up to return `ACP_REMOTE_ERROR` with an "already open in another process" message. Release the session through that owning client, inspect the blocked job, then send an explicit consecutive revision with `acknowledge_partial_work: true`. Repeating the blocked revision returns its existing job. The bridge does not close another client's session or automatically retry the prompt. A leftover Devin PID file alone does not establish that its owner is still running; do not delete it to force a resume.

## Verification and acceptance

After the turn finishes, call `devin_report` with its `job_id`. The report is projected from durable `job.json`, independently of the 256-event rolling buffer, and remains retrievable after restarting the bridge. It contains the retained answer (up to the existing 32,768-character text retention limit) and current evidence; it does not reconstruct evicted or truncated text. `answer.output_truncated` remains visible. Active/finalizing jobs return `JOB_ACTIVE`.

```json
{"job_id":"<returned-job-id>"}
```

The report keeps these decisions separate:

| Field | Interpretation |
| --- | --- |
| `job_state` | Existing terminal state, preserved for compatibility. |
| `execution.status` | Whether execution completed, failed, was refused, interrupted/cancelled/timed out, or never started. |
| `evidence.completeness` | Completeness of observed workspace evidence, with reasons for limitations. |
| `policy.status` | Clear, blocked actions, scope violation, or unknown; blockers remain inspectable. |
| `verification.status` | Complete, failed, incomplete, or no checks declared; each check retains its evidence source. |
| `acceptance.status` | `pending_lead_review`; `task_accepted: false` is pending acceptance, not an automatic failed-work verdict. |

A turn that ends normally but encounters a denied command can retain legacy `job_state: "blocked"` while reporting `execution.status: "completed"`, its useful answer, and `policy.status: "blocked_actions"`. Retrieving that report succeeds as an MCP call. This does not erase the denial or establish that the answer meets the assignment. Similarly, incomplete evidence or scope violations remain visible after execution ends. `problem` retains the compact execution/problem error when present.

New jobs record whether this revision attempted a prompt. A preflight-blocked follow-up remains `not_started` even though it retains the earlier session ID; its declared checks remain `not_run` rather than disappearing. Version 0.1 reports are marked `legacy: true`; their recorded successful execution can be reported, while missing newer scope/evidence fields remain unknown.

Progress responses and changed terminal quiet responses also include an additive `outcome` with these separate classifications. Quiet handoffs cap their serialized content at 16 KiB, with a summary tail of at most 4 KiB. Reports return the full retained answer and bounded diagnostic previews; inspect truncation/count fields and referenced private records for additional detail. Native evidence recorded after completion appears in the next report and invalidates the prior quiet acknowledgment token.

Review the answer, scope, source, each check, and acceptance criteria before accepting the task. The bridge leaves acceptance to the Lead. Incomplete evidence or output must not become a clean-success claim.

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
