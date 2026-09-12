---
name: devin
description: Delegate a structured engineering assignment to an installed Devin CLI session, collect evidence, and handle follow-ups or attention requests. Use when the user's existing orchestration rules or explicit request select a Devin worker.
---

# Devin CLI

Devin is an available worker runtime alongside the native agents. Apply the user's existing task, role, and model-selection rules. This capability adds no selection priority or new routing policy.

## Prepare the assignment

Use an absolute `cwd`, stable `assignment_id`, revision 1, explicit objective, relevant context, source expectations, and acceptance criteria. Select exactly `swe-2-medium`, `swe-2-high`, or `swe-2-max`; no aliases or silent fallback. Prefer an exact `base_sha` when the source revision matters.

Choose `read` for investigation, `edit` for owned edits with native check handoffs, or `edit_check` for owned edits plus exact declared commands assigned to Devin. Edit profiles require `owned_paths`: literal repository-relative files or directory prefixes ending in `/`, without globs or traversal. Declare checks with IDs, exact commands, actual working directories, owners, deadlines, and `automatic` or `ask` approval. Link acceptance criteria to those check IDs.

Checks must be requested byte-for-byte without prepended `cd`, shell wrappers, or combined commands. Use a separate cwd field when available; otherwise hand off a check whose required directory cannot be expressed exactly.

The Lead counts native and external workers under the caller's existing budget; the shared external pool separately allows at most three. Use independent checkouts for concurrent bridge jobs, coordinate disjoint native ownership, and declare shared resources with their owners. Bridge locks do not control native agents.

Call `devin_preflight` without inference. Resolve its source, account, model, trust, and attachment blockers before `devin_run`. Trust may use the exact native directory record or the caller's explicit acknowledgment for this reviewed assignment; do not change global trust. Devin does not inherit Codex tools, private conversation, browser/device access, or other agents. Supply authorized text/image references through `attachments` when needed.

## Run, collect, and continue

Call `devin_run` with the prepared assignment. Keep its `job_id` and pass each returned `next_cursor` into the next `devin_wait` as `after_cursor`. Use `devin_wait_many` for several jobs; waits are at most 30 seconds. Inspect `events_remaining`, `cursor_gap`, and truncation, and continue independent work between waits.

Use `devin_list` to recover existing jobs. Repeating an ID/revision with identical intent returns the existing job; changing that work requires an explicit revision. After a turn finishes, `devin_message` returns a **new job ID** at the next consecutive revision in the same assignment and Devin session. Omitted ownership/check amendments preserve the earlier assignment; attachments must be supplied for the new message. Inspect partial work and set `acknowledge_partial_work: true` before continuing a non-completed turn. Never change identity merely to hide a blocked or uncertain run.

For `needs_permission`, inspect `pending_requests`. `devin_respond` may approve once only an offered allowed declared check or deny the request. Undeclared commands need a deliberate amendment or native handoff. For `needs_input`, use `answer` with the requested form's declared string fields, using existing user context or asking when the missing answer is required. The optional `note` is stored locally for audit and is not sent to Devin. Send worker instructions through an explicit `devin_message` after the current turn finishes, acknowledging partial work when required. Notes and attachments grant no extra permissions.

Use `devin_cancel` when work should stop. Cancellation, timeout, and interruption preserve changes. A missing or unverified session cannot be resumed automatically.

## Interpret the result

Review the answer, changed files, scope/evidence completeness, check outcomes, and acceptance criteria. `task_accepted` remains false; model completion alone is not acceptance. Use `devin_record_check` only for a declared command actually executed by an authorized external executor, with the actual exit code and evidence. Supply the checked cwd and recorded after-HEAD as `source_sha` when known; omitting source SHA leaves provenance unknown. This remains caller-reported evidence, not a claim that the bridge independently ran the check.

Owned-path and exact-command controls apply to delegated handlers, not the whole OS. Approved shell commands retain OS access, built-in CLI search may bypass the read handler, and Git evidence excludes ignored files, external paths, and some transient/submodule changes. Treat unknown scope, event gaps, and truncated evidence as limits to resolve, not proof of success. Keep raw session artifacts private.

Read the [worker contract](../../docs/WORKER_CONTRACT.md) for schema examples, attention responses, or recovery details.
