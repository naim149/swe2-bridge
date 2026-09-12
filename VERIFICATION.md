# Verification and current limits

Version 0.3 is an experimental local session-worker integration. The checks below used real Devin/SWE-2 calls, disposable Git worktrees, local child processes, and real MCP connections. Version 0.2 evidence is retained separately from the new qualification. These checks establish observed behavior, not exhaustive reliability or a model benchmark.

## Environment

Maintainer verification on September 12, 2026:

| Component | Tested version |
| --- | --- |
| Platform | macOS 26.5.2, Apple Silicon |
| Codex desktop / CLI | 26.908.40834 / 0.154.0-alpha.6.2 |
| Devin CLI / protocol | 3000.10.23 (deb81600) / ACP v1 |
| Node / MCP SDK | 22.23.1 / 1.30.0 |
| Model and account | Exact `swe-2-medium`; separate `swe-2-max` lifecycle probes; authenticated Devin Pro |

Only macOS runtime support is verified. Linux is experimental; Windows is unsupported. Linux source CI is not evidence of Linux Devin runtime compatibility. The original integration trials used Medium. Max was additionally checked for read-only turn continuity and session contention as described below; High inference remains unverified. Catalog visibility is neither successful inference nor a price guarantee.

## Version 0.3 review and report qualification

An isolated public-installer build, `0.3.0+codex.b56bacea93c6a4cddb1b`, exposed all ten tools through a real MCP stdio connection. Exact `swe-2-max` performed two bounded disposable tasks:

| Scenario | Observed result |
| --- | --- |
| Missing comparison | Preflight rejected a missing commit with `ready: false` and `review.complete: false` before checking the CLI or submitting inference. |
| Prepared immutable review | The committed comparison introduced a pagination offset bug, while the dirty working copy contained the correct code and a different root instruction file. Using only the packet, the worker returned the correct line-level finding, concrete input/output examples, both exact commit IDs, and both immutable root/nested instruction markers. No worker tool calls or file changes were observed. |
| Packet identity | Preflight and the final report agreed on the comparison and packet hashes. Dirty fixture files remained byte-for-byte unchanged. |
| Evicted events and restart | The review generated 449 events; only cursors 194–449 remained. Quiet output truthfully reported a cursor gap. The full retained answer was still retrieved, and a fresh bridge instance returned an identical report. |
| Real denied check | A second job requested `node --version` with one-time approval. The fixture denied it. The model still returned the exact file marker and correctly reported that the check did not run. The report retrieved successfully with legacy `job_state: blocked`, execution `completed`, policy `blocked_actions`, verification `incomplete`, the `PERMISSION_DENIED` blocker, and `task_accepted: false`. No files changed. |
| Quiet acknowledgment | Passing the terminal `next_token` suppressed the repeated handoff for both jobs. |

The packet trial qualifies one small text comparison and its instructions, not arbitrary PR review quality. The worker explicitly described missing wider semantic context. Subsequent diagnostic fixes carry restricted snapshot coverage into final reports and enforce the 16 KiB handoff limit even for JSON-escaped metadata; those are covered by the regression and independent review below.

A fresh ephemeral Codex task then qualified the final runtime from personal installation `0.3.0+codex.20260912151250`, whose runtime source hashes matched the reviewed source. It invoked the actual installed `devin_preflight`, `devin_run`, quiet `devin_wait`, and two `devin_report` calls. The new exact-Max review again found the committed pagination bug and both instruction markers with zero worker tool calls or edits. Codex also retrieved the earlier denied-check report successfully without rerunning it and kept acceptance pending. The temporary isolated authentication copy was removed afterward.

The current source/regression suite passes 96 tests without Devin inference. It includes the version 0.2 baseline plus real Git SHA-1/SHA-256 fixtures, changed-file/instruction and byte limits, binary/LFS/gitlink/symlink blockers, exact immutable identity, dirty/divergent checkout handling, quiet modes/cursors/tokens/cancellation, durable reports, native-evidence provenance, early-blocked follow-ups, and legacy report handling. Real SDK/stdio tests verify tool schemas and successful report retrieval after a blocked job. No fake Devin executable or network inference is used by regression tests or CI.

Independent review found and resolved configured Git helpers executing during review snapshots, lost early-start check declarations, incorrect classification of unstarted follow-ups, legacy report ambiguity, dropped reduced-coverage explanations, and a JSON-escaping handoff bound. Real Git controls invoked filesystem monitors/conversion filters; restricted packet and snapshot reads invoked none. Filter and submodule exclusions remain incomplete evidence with explicit limitations through snapshots, assessment, reports, and quiet handoffs. Custom hunk-function configuration and info-attributes driver changes no longer alter packet identity. Non-review snapshot behavior remains unchanged.

## Quiet waits on the actual Codex host

A development installation with version `0.2.0+codex.c7f940291362e54b8d11` qualified the new wait behavior before final version 0.3 packaging. Its source hashes and raw records are retained privately. One exact `swe-2-max` job used a disposable repository and a sole declared 300-second Node timer check. Two real MCP SDK clients observed the same job for approximately 168.4 seconds, both with `wait_seconds: 55` and a 75-second timeout:

| Mode | Returned MCP results | Serialized UTF-8 JSON bytes |
| --- | --- | --- |
| Progress | 8 | 122,640 |
| Quiet | 4 | 7,378 |

Quiet returned three bounded timeouts and one terminal handoff. This measures result count and returned serialized bytes for one fixture, not account token usage, general savings, or a model-quality benchmark. Later version 0.3 reporting fixes change some returned fields, so these byte totals describe that recorded qualification build.

An ephemeral Codex app-server task loaded the installed plugin and exercised the actual host:

| Probe | Observed result |
| --- | --- |
| Direct MCP quiet wait | Successfully held for 55,053 ms under configured tool timeout 75 seconds. |
| Concurrent host request | `thread/loaded/list` completed in less than the 1 ms measurement resolution while the wait was held. |
| Steering a waiting model turn | RPC accepted in 1 ms; steered message acknowledged 56,122 ms later, after the held wait finished. Steering was queued. |
| Interrupting a waiting model turn | Turn interruption returned in 4 ms; a subsequent status query took 9 ms and the Max job remained running. |
| Explicit fixture job cancellation | Quiet terminal wake arrived in 466 ms; source was unchanged and both worker/check process groups were gone. |

The host trial proves a 55-second call works; it does not locate the exact host timeout boundary. No MCP item-completion event appeared for the interrupted wait, so host-level propagation/timing of the server's abort signal was not independently proven. A separate real SDK/stdio regression observes the unchanged server wait settling with internal `WAIT_CANCELLED`, no active wait handler, and unchanged worker records. MCP suppresses cancelled tool responses; the caller receives its SDK/host cancellation result.

There is no new background scheduler or verified unsolicited agent-wakeup channel. A caller must issue another bounded wait, or retrieve the durable result later. Use shorter waits when queued steering latency matters. These tests used only disposable state and an isolated Codex configuration; the temporary authentication copy was removed.

## Version 0.2 real session trials

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

## Text attachment and response-note investigation

Additional real Medium probes used the versions above and fresh disposable sessions. The text probes called the production `normalizeAssignment`, `prepareContent`, and `AcpClient` directly. Each source attachment was deleted after content preparation and before submission; the read callback rejected file access. No tool calls or file reads were observed.

| Probe | Observed result |
| --- | --- |
| Small UTF-8 embedded resource | The worker returned a random marker supplied only inside the attachment, plus exact accented Latin and Arabic text. The session advertised `embeddedContext: true`. |
| Plain-text control | A separate session received a different random marker through an ordinary text block and returned it and the Unicode text exactly. This control did not change production serialization. |
| Document-sized embedded resource | The 14,439-byte worker contract was expanded to 14,600 bytes with random markers near its start, middle, and end, plus Unicode. The worker returned all markers and the Unicode exactly and correctly summarized a requested contract clause. |
| Denial-note visibility | A real `SessionManager` job requested an exact declared check with one-time approval. Denial included a random marker only in `devin_respond.note`. The marker was persisted locally, but the worker reported only the generic rejection and no separate note. The check did not run and no files changed. |

These probes demonstrate embedded-text delivery for the tested sizes and content; they do not establish that a worker will follow every attached reference in a complex assignment. No dropped-resource bug was reproduced, so the embedded-resource format is unchanged. If source use is uncertain, an explicit follow-up can ask the worker to identify a specific fact from the supplied reference before continuing.

Response notes are local audit context, not a worker message channel. Tool and agent guidance now state this explicitly. Instructions or corrections must be sent through a deliberate next-revision `devin_message` after the current turn ends, with partial-work acknowledgment where required. The bridge does not silently add another prompt or retry denied work.

## Max follow-ups and session contention

A reported Max follow-up failed because Devin desktop acquired the session between bridge turns. Read-only inspection found the first bridge turn's `SessionEnd` before terminal completion, followed about a minute later by desktop opening that session and acquiring its lock under a different, earlier-started ACP process. The next bridge revision then received the upstream `session_locked` error. That desktop ACP instance later released the session and exited; the investigation did not operate that client or its jobs.

Separate disposable probes used the unchanged production bridge and exact `swe-2-max`:

| Scenario | Observed result |
| --- | --- |
| Immediate follow-ups | Three consecutive turns completed in the same session and retained a conversation-only marker. Each recorded worker PID was absent at terminal completion; no files changed. |
| Competing client | A separate real ACP client loaded that fixture session. The next bridge revision was blocked at session loading with the same "already open in another process" error. No prompt was submitted and the owning client remained alive. |
| Explicit recovery | After deliberately closing the fixture's owning client, a new consecutive revision with partial-work acknowledgment completed, recalled the original marker, and changed no files. |

No bridge cleanup race was reproduced, and no shutdown, routing, or automatic-retry change was made. The worker contract and setup guide now explain competing session ownership and explicit recovery. These Max probes qualify this limited lifecycle behavior, not engineering quality, long assignments, or broad equivalence with other models. Exact recovery rules for leftover provider PID files remain unverified; file presence alone is not live-process evidence.

## Version 0.2 regression baseline

The merged version 0.2 baseline ran 30 tests using real files, Git repositories, and local child processes. It needed no Devin installation, account, mocked Devin executable, or model inference. Coverage included:

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
