# Verification and current limits

Version 0.2 is an experimental local session-worker integration. The checks below used real Devin/SWE-2 calls, disposable Git worktrees, local child processes, and real MCP connections. They establish the observed behavior, not exhaustive reliability or a model benchmark.

## Environment

Maintainer verification on September 12, 2026:

| Component | Tested version |
| --- | --- |
| Platform | macOS 26.5.2, Apple Silicon |
| Codex desktop / CLI | 26.908.40834 / 0.154.0-alpha.6.2 |
| Devin CLI / protocol | 3000.10.23 (deb81600) / ACP v1 |
| Node / MCP SDK | 22.23.1 / 1.30.0 |
| Model and account | Exact `swe-2-medium`, authenticated Devin Pro |

Only macOS runtime support is verified. Linux is experimental; Windows is unsupported. Linux source CI is not evidence of Linux Devin runtime compatibility. High and Max are accepted exact model IDs, but the inference trials below used Medium. Catalog visibility is neither successful inference nor a price guarantee.

## Real session trials

| Scenario | Observed result |
| --- | --- |
| Read, image, and question | In `read`/ACP `ask` mode, SWE-2 read the fixture, identified the supplied PNG as red, asked a structured form question, and incorporated the supplied answer. No files changed. |
| Owned edit and check | SWE-2 changed subtraction to addition in its owned file. The actual declared Node test command passed through the bridge terminal with exit code zero and retained output evidence. |
| One-time approval | An `approval: "ask"` check became `needs_permission`. A second bridge instance discovered the pending request and approved it once. |
| Follow-up continuity | A new revision created a new job, loaded the same Devin session, recalled an identifier supplied only in the earlier conversation, added a bounded comment, and passed the declared check again. |
| Duplicate delivery | Repeating the same assignment/revision returned its existing job. Repeating the follow-up also reused its job. Discovery returned both linked revisions. |
| Concurrent work | Two SWE-2 jobs ran in independent Git worktrees while a native fixture command produced independent evidence. A competing assignment in the occupied checkout was rejected. Multi-wait returned separate cursors and attention states. |
| Preserve unrelated work | Dirty tracked notes and a pre-existing untracked file remained byte-for-byte unchanged. Git scope evidence identified only the assigned implementation file. |
| Undeclared command | In the first combined trial, the model prepended `cd` to a declared command. Exact matching rejected it; approval was unavailable. The prompt now explicitly requires copying commands without wrappers. The repeated combined trial passed. No permissive fallback was added. |
| Abrupt owner crash | The bridge owner was killed with SIGKILL after a real declared check had started. A fresh instance reported unknown post-interruption changes, deduplicated the original assignment, and kept the checkout locked while the detached check survived. |
| Orphan cancellation and resume | Identity-checked cancellation stopped that surviving check group. An unacknowledged follow-up was rejected. An explicitly acknowledged follow-up loaded the same Devin session, read the partial state, and completed without replaying the cancelled command. Its delayed write never occurred. |
| ACP transport behavior | Direct real ACP probes verified exact model metadata, load-session replay, filesystem callbacks, command allow/deny, terminal interception with actual cwd, image input, form elicitation, and cancellation during a pending permission request. |

Disposable fixtures used explicit, directory-specific trust acknowledgment. ACP does not enforce the CLI print-mode trust gate; the bridge separately checks the native exact-directory trust registry or records caller acknowledgment. No global trust or permission setting was changed.

## Focused regression coverage

`npm test` runs 30 tests using real files, Git repositories, and local child processes. It needs no Devin installation, account, mocked Devin executable, or model inference. Coverage includes:

- Exact-model validation, ownership paths, symlink/hard-link escape rejection, check references, attachment frame limits, file limits, and Git evidence across dirty/index/committed states.
- Durable command ownership before an execution gate opens, failed persistence, owner death before the gate, check deadlines, cancellation, descendant cleanup, release/session isolation, and a 32-start limit.
- Bounded UTF-8 output, lossy/truncated evidence remaining unknown, private artifact hashes, and aggregate retention limits.
- Duplicate delivery across instances and restart, conflicting intent, concurrent native evidence recording, executor/cwd/source mismatch rejection, interrupted finalization, and locks retained for surviving check processes.
- Real check output remaining historical evidence when later edits make it stale, and unknown source binding when a check itself changes the observed workspace.

Source checks cover runtime/installer syntax and plugin metadata. CI installs pinned dependencies without lifecycle scripts, runs source/regression checks, and validates JSON; it performs no inference. Independent review found and resolved premature completion persistence, orphan check ownership, cancellation versus file-write races, unbounded cached tool payloads, and concurrent evidence overwrite.

## Installation evidence

The previous public version was tested with real Codex plugin installation/reinstallation/removal in isolated configuration directories, a checkout path containing spaces, a narrow GUI-style PATH, and a fresh installed Codex invocation. Those historical results remain available in the [version 0.1 verification record](https://github.com/naim149/swe2-bridge/blob/e87e2c5201688ae5748126f4a4013e5f7fa3c20f/VERIFICATION.md).

The v0.2 prerequisite doctor and installer dry-run pass. Actual installation and reinstall in an isolated Codex configuration succeeded. An MCP client connected to the installed cache, discovered all nine tools, passed real no-inference preflight, and rejected an invalid model alias.

A fresh ephemeral Codex session loaded the personal plugin, invoked its actual run/wait tools, and received a completed exact-Medium result: one owned file edit, a real passing Node check, and `source_binding: matches_final_observed_state`. Parent inspection confirmed the persisted evidence. Codex's normal automatic approval review authorized that explicitly scoped fixture invocation. An earlier read-only/never-approval invocation was blocked before job creation by the host; the bridge did not bypass host approvals. A mistyped source hash was also rejected before creating a job.

## Remaining limits

Long engineering assignments, a second physical installation, Linux runtime, quota/auth expiry, network interruption, disk exhaustion, and escaped/daemonized subprocesses are not fully qualified. The happy-path trial uses two external workers; it does not establish sustained three-worker throughput or application-specific build/device coordination. A representative project assignment remains necessary before adopting a broader worker policy.

Delegated filesystem and terminal callbacks enforce their specific contracts. Built-in search, authorized shell programs, ignored files, external paths, transient reverted changes, and some submodule contents remain outside complete observation or containment. This is not an OS sandbox. Check commands run with the local account's permissions; callers must authorize their effects deliberately.

Events, text, attachments, and artifacts are bounded. Follow `next_cursor`, inspect gaps/truncation, and treat unknown evidence as unknown. Native check records are caller-reported evidence with declared ownership and optional source provenance, not independent attestations. Every result retains `task_accepted: false` for the Lead's review.

Raw prompts, records, form answers, outputs, diffs, and protocol probes remain private. Share only sanitized reproduction steps and observed outcomes. SWE-2 handled the bounded engineering and image tasks successfully; these trials do not rank it against other models or predict complex-project quality.
