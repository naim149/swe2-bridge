#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SessionManager } from './session-manager.mjs';

const failedStates = new Set(['failed', 'blocked', 'interrupted', 'timed_out', 'incomplete']);
const modelSchema = z.enum(['swe-2-medium', 'swe-2-high', 'swe-2-max']);
const jobIdSchema = z.string().min(1).max(128).describe('Job identifier returned by the bridge.');
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const baseShaSchema = z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i).describe('Exact Git commit ID expected for this assignment; not a branch name.');
const reviewSchema = z.object({
  base_sha: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i),
  head_sha: z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/i),
}).describe('Immutable comparison commits for a read-profile review. Prepares the actual bounded diff, changed paths, and applicable repository instructions before inference. These commits are separate from base_sha, which asserts the checkout HEAD. Incomplete comparisons block preflight.');
const ownedPathsSchema = z.array(z.string().min(1).max(4096)).max(256).describe('Owned literal relative file paths or directory prefixes ending in /. Required for edit profiles; globs and traversal are not allowed.');
const checkSchema = z.object({
  id: z.string().trim().min(1).max(128),
  command: z.string().min(1).max(8192).describe('Exact declared shell command; commands are not interchangeable.'),
  cwd: z.string().min(1).max(4096).optional().describe('Absolute check directory inside the assignment cwd; omit for the assignment cwd.'),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe('Check deadline in seconds; defaults to 60.'),
  owner: z.string().trim().min(1).max(128).optional().describe('Executor owner. Use devin for the worker; another owner is a handoff to that executor.'),
  approval: z.enum(['automatic', 'ask']).optional().describe('Whether the declared check needs an explicit approval response; defaults to automatic.'),
});
const checksSchema = z.array(checkSchema).max(32);
const attachmentSchema = z.object({
  path: z.string().min(1).max(4096).describe('Absolute local path to a PNG, JPEG, WebP, or UTF-8 text reference; URLs are not fetched.'),
  mime_type: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(255).optional(),
});
const attachmentsSchema = z.array(attachmentSchema).max(8);
const waitSecondsSchema = z.number().int().min(0).max(55).default(10).describe('Wait up to this many seconds; zero returns an immediate snapshot. Cancelling this wait does not cancel the worker.');
const waitModeSchema = z.enum(['progress', 'quiet']).default('progress').describe('progress returns transcript events as before; quiet waits for a new terminal outcome, new actionable request, an error, or timeout and returns compact state.');
const afterCursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).describe('Last delivered transcript cursor. In progress mode, pass returned next_cursor to consume event pages. Quiet preserves this cursor without consuming events; cursor is the latest server position.');
const afterTokenSchema = z.string().regex(/^[0-9a-f]{64}$/).optional().describe('In quiet mode, acknowledge this job\'s previous compact state using its returned next_token. Keep a separate token for each job.');
const assignmentSchema = {
  task: z.string().trim().min(1).max(65536).describe('Bounded objective, required context, constraints, and expected result.'),
  cwd: z.string().min(1).max(4096).describe('Absolute path to the existing working directory.'),
  model: modelSchema.optional().describe('Exact Devin model. Omit to use the configured default, initially swe-2-medium. No alias or silent fallback is accepted.'),
  assignment_id: z.string().trim().min(1).max(256).optional().describe('Stable assignment identity for deduplication and recovery. Reuse it to inspect an existing assignment instead of blindly replaying work.'),
  revision: revisionSchema.default(1).describe('Assignment revision, starting at 1. Amend an existing session with devin_message.'),
  role: z.string().trim().min(1).max(128).optional().describe('Role chosen by the Lead using existing delegation rules.'),
  base_sha: baseShaSchema.optional(),
  review: reviewSchema.optional(),
  scope: z.string().trim().min(1).max(16384).optional().describe('Additional task and ownership constraints communicated to the worker.'),
  owned_paths: ownedPathsSchema.optional(),
  profile: z.enum(['read', 'edit', 'edit_check']).default('edit').describe('read: investigation; edit: owned filesystem edits; edit_check: owned edits plus exact declared checks assigned to Devin.'),
  checks: checksSchema.optional().describe('Declared verification commands and their execution owners; defaults to no commands.'),
  acceptance: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(8192),
    check_ids: z.array(z.string().trim().min(1).max(128)).max(32).default([]).describe('IDs of checks declared in this assignment that support the criterion.'),
  })).max(64).optional().describe('Acceptance criteria the Lead must evaluate; worker completion does not establish acceptance.'),
  resources: z.array(z.object({
    name: z.string().trim().min(1).max(128).describe('Namespaced shared resource, such as build:ios or device:simulator-1.'),
    owner: z.string().trim().min(1).max(128),
  })).max(32).optional().describe('Named resources and their owners for coordination; not additional permissions.'),
  attachments: attachmentsSchema.optional().describe('Explicit local reference attachments, embedded as bounded content rather than inherited conversation context.'),
  workspace_trust: z.enum(['inherit', 'acknowledged']).default('inherit').describe('Use Devin workspace trust, or explicitly acknowledge this reviewed workspace with a trust_reason. Does not change global trust.'),
  trust_reason: z.string().trim().min(1).max(4096).optional().describe('Reason this specific workspace is trusted when workspace_trust is acknowledged.'),
  timeout_seconds: z.number().int().min(1).max(3600).default(900).describe('Maximum worker duration in seconds.'),
};

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

async function invoke(operation) {
  try {
    const value = await operation();
    // Permission and input requests are normal attention states, not failed tool calls.
    return result(value, failedStates.has(value.state ?? value.status));
  } catch (error) {
    return result({
      state: error?.state ?? 'error',
      error: {
        code: typeof error?.code === 'string' ? error.code : 'BRIDGE_ERROR',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      },
    }, true);
  }
}

async function main() {
  const manager = new SessionManager();
  const server = new McpServer(
    { name: 'devin-bridge', version: '0.3.0' },
    {
      instructions: [
        'Devin CLI is an available worker for delegated engineering tasks.',
        'Apply the existing user instructions for roles, task complexity, and model selection.',
        'Use devin_preflight to inspect a structured assignment and prerequisites without inference.',
        'Provide an absolute working directory, stable assignment identity, revision, explicit owned paths for edits, declared checks, and acceptance criteria.',
        'For a Git/PR review, use read profile with explicit immutable review.base_sha and review.head_sha; the outer base_sha asserts checkout HEAD. Preflight prepares a bounded complete diff, changed paths and applicable head-tree instructions, or blocks before inference. It adds no worker Git/history or shell capability.',
        'Use devin_run once, then devin_wait or devin_wait_many with returned job IDs and event cursors; use devin_list to recover existing assignments instead of blindly replaying work.',
        'Waits default to progress mode. Opt into quiet mode for compact waits that ignore ordinary progress and wake for new terminal outcomes or actionable requests, errors, or timeout. Pass each returned next_token as that job\'s after_token; remove completed jobs or acknowledge their terminal state. Quiet preserves transcript cursors for later progress diagnostics.',
        'Use devin_message for an explicit revision or follow-up in the existing session, and acknowledge any partial work before resuming an interrupted assignment.',
        'The shared bridge pool allows at most four independent jobs. The Lead counts native and external workers together under the existing delegation limits and coordinates file and resource ownership.',
        'The bridge enforces owned paths for delegated filesystem writes and exact permissions for declared check commands. These controls are not an operating-system sandbox.',
        'needs_permission and needs_input require attention. devin_respond can approve once only an offered allowed declared check, deny it, or answer a requested form. Unknown commands need an amended assignment or a native-executor handoff.',
        'Codex tools, private conversation context, other agents, and device or browser capabilities are not inherited by Devin; supply the required context explicitly.',
        'Use devin_record_check for verification actually performed by an authorized external executor. Review evidence and acceptance criteria before treating the work as complete.',
        'After a turn finishes, use devin_report for its retained answer and evidence independently of event retention. Inspect execution, evidence completeness, policy findings, verification, and Lead acceptance separately. task_accepted=false means pending Lead acceptance; useful completed answers remain retrievable after denied actions.',
        'Use devin_cancel to stop a job. Cancellation, deadlines, and interruptions preserve partial workspace changes.',
        'Cancelling a wait stops only that wait; use devin_cancel to stop its worker.',
      ].join(' '),
    },
  );

  server.registerTool('devin_preflight', {
    title: 'Preflight Devin assignment',
    description: 'Inspect an assignment, local prerequisites, source assumptions, ownership, attachments, and check policy without starting model inference. Optional read-profile review prepares the explicit two-commit diff, changed paths and applicable head-tree instructions; missing or unsupported comparison evidence blocks readiness. Use the same structured assignment when starting the job.',
    inputSchema: assignmentSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, (args) => invoke(() => manager.preflight(args)));

  server.registerTool('devin_run', {
    title: 'Run Devin worker',
    description: 'Start or recover a durable Devin assignment. Returns a job_id promptly; collect events and results with the wait tools. Edit profiles require owned_paths; only edit_check permits exact declared commands assigned to Devin. At most four independent bridge jobs share the pool.',
    inputSchema: assignmentSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (args) => invoke(() => manager.run(args)));

  server.registerTool('devin_message', {
    title: 'Continue Devin assignment',
    description: 'Continue the same Devin session as a new job with a consecutive revision. Omitted base_sha uses the prior observed after-HEAD when available; owned_paths, checks and review comparison retain prior values. Supply review explicitly to compare different immutable commits. Inspect and acknowledge partial work before resuming an unsuccessful assignment.',
    inputSchema: {
      job_id: jobIdSchema,
      revision: revisionSchema.describe('Revision for this message; use the current assignment state to choose the next revision.'),
      task: z.string().trim().min(1).max(65536).describe('Follow-up objective and explicit changes to the assignment.'),
      base_sha: baseShaSchema.optional(),
      review: reviewSchema.optional(),
      owned_paths: ownedPathsSchema.optional(),
      checks: checksSchema.optional(),
      attachments: attachmentsSchema.optional().describe('Reference attachments for this message; prior attachments are not implicitly resubmitted.'),
      acknowledge_partial_work: z.boolean().default(false).describe('True only after inspecting and accepting the existing partial workspace changes before continuation.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (args) => invoke(() => manager.message(args)));

  server.registerTool('devin_wait', {
    title: 'Wait for Devin worker',
    description: 'Wait up to 55 seconds for a job. Default progress mode returns transcript events after after_cursor. Quiet mode ignores ordinary progress and returns compact state for a new terminal outcome, new actionable request, error, or timeout; acknowledge next_token as after_token. Quiet preserves the transcript cursor. Cancelling this wait does not stop the worker.',
    inputSchema: {
      job_id: jobIdSchema,
      mode: waitModeSchema,
      after_cursor: afterCursorSchema,
      after_token: afterTokenSchema,
      wait_seconds: waitSecondsSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (args, extra) => invoke(() => manager.wait(args, { signal: extra.signal })));

  server.registerTool('devin_wait_many', {
    title: 'Wait for Devin workers',
    description: 'Collect 1–32 jobs in one wait of at most 55 seconds. Progress mode uses each transcript cursor. Quiet mode uses each job\'s after_token to wait for new terminal outcomes or actionable requests, errors, or timeout without ordinary progress. Remove completed jobs or acknowledge their terminal token to avoid repeated wakeups. Cancelling this wait does not stop any worker.',
    inputSchema: {
      jobs: z.array(z.object({ job_id: jobIdSchema, after_cursor: afterCursorSchema, after_token: afterTokenSchema })).min(1).max(32),
      mode: waitModeSchema,
      wait_seconds: waitSecondsSchema,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (args, extra) => invoke(() => manager.waitMany(args, { signal: extra.signal })));

  server.registerTool('devin_list', {
    title: 'List Devin assignments',
    description: 'List persisted jobs, optionally filtered by stable assignment identity. Use this to recover job IDs and inspect earlier work before starting or resuming an assignment.',
    inputSchema: {
      assignment_id: z.string().trim().min(1).max(256).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(4096).optional().describe('Opaque pagination cursor returned by an earlier list call.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, (args) => invoke(() => manager.list(args)));

  server.registerTool('devin_report', {
    title: 'Read durable Devin report',
    description: 'Retrieve a finished job\'s retained answer and evidence from its durable record, independently of progress-event retention. Reports remain useful after denied operations. Execution, evidence, policy findings, verification and pending Lead acceptance are separate; task_accepted=false is not a failed-work verdict. Inspect truncation and the full record when needed.',
    inputSchema: { job_id: jobIdSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => invoke(() => manager.report(args)));

  server.registerTool('devin_respond', {
    title: 'Respond to Devin attention request',
    description: 'Respond to a pending permission or input request. Approve once only an offered allowed declared check, deny a request, or answer its form using the requested schema. Unknown commands require an amended assignment or native-executor handoff; this tool does not expand permissions.',
    inputSchema: {
      job_id: jobIdSchema,
      request_id: z.string().min(1).max(256).describe('Exact pending request ID returned in the job\'s attention state.'),
      decision: z.enum(['approve_once', 'deny', 'answer']),
      answers: z.record(z.string(), z.unknown()).optional().describe('Answers for decision=answer, matching the pending form\'s requested schema.'),
      note: z.string().trim().min(1).max(4096).optional().describe('Optional local audit explanation, stored with the response and not sent to Devin. To give the worker instructions, use devin_message after the current turn finishes. This note grants no execution permission.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (args) => invoke(() => manager.respond(args)));

  server.registerTool('devin_cancel', {
    title: 'Cancel Devin worker',
    description: 'Stop an existing Devin job and return its cancellation or existing terminal state. Cancellation preserves changes already made in the working directory.',
    inputSchema: {
      job_id: jobIdSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, ({ job_id }) => invoke(() => manager.cancel(job_id)));

  server.registerTool('devin_record_check', {
    title: 'Record external verification',
    description: 'Record a declared check actually performed by an authorized native or other external executor. This tool records evidence; it does not execute the command or establish acceptance by itself. Report passed only when supported by the actual result.',
    inputSchema: {
      job_id: jobIdSchema,
      check_id: z.string().trim().min(1).max(128).describe('ID of the declared check being reported.'),
      status: z.enum(['passed', 'failed', 'blocked']),
      command: z.string().min(1).max(8192).describe('Exact command actually executed or blocked.'),
      exit_code: z.number().int().min(-2147483648).max(2147483647).optional(),
      cwd: z.string().min(1).max(4096).optional().describe('Canonical directory where the declared check ran.'),
      source_sha: baseShaSchema.optional().describe('Recorded after-HEAD tested by the native executor; omitted provenance remains unknown.'),
      artifact_paths: z.array(z.string().min(1).max(4096)).max(16).default([]).describe('Local paths to actual verification evidence; keep private artifacts out of public reports.'),
      executor: z.string().trim().min(1).max(128).describe('Executor that performed the check, matching its declared ownership.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, (args) => invoke(() => manager.recordCheck(args)));

  let stopping;
  async function shutdown(exitCode = 0) {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await manager.close();
      } catch (error) {
        process.stderr.write(`Devin bridge cleanup failed: ${error.message}\n`);
        exitCode = 1;
      }
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`Devin bridge transport close failed: ${error.message}\n`);
        exitCode = 1;
      }
      process.exitCode = exitCode;
      process.stdin.pause();
    })();
    return stopping;
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { void shutdown(); });
  }
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('error', (error) => {
    process.stderr.write(`Devin bridge input failed: ${error.message}\n`);
    void shutdown(1);
  });
  process.stdout.once('error', (error) => {
    if (error.code !== 'EPIPE') process.stderr.write(`Devin bridge output failed: ${error.message}\n`);
    void shutdown(error.code === 'EPIPE' ? 0 : 1);
  });

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`Devin bridge startup failed: ${error.message}\n`);
    await shutdown(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Devin bridge failed: ${error.message}\n`);
  process.exitCode = 1;
});
