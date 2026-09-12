import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionManager } from '../src/session-manager.mjs';
import { jsonFile } from '../src/runner.mjs';

const exec = promisify(execFile);
const tokenPattern = /^[a-f0-9]{64}$/;
const posix = { skip: process.platform === 'win32' ? 'POSIX-only bridge' : false, timeout: 5000 };
const terminalStates = ['completed', 'blocked', 'failed', 'cancelled', 'timed_out', 'interrupted', 'incomplete'];

// These are persisted lifecycle fixtures, not simulated Devin responses. No
// manager.run(), CLI, ACP session, model backend, or inference is started here.
// The test process really owns ordinary fixtures; one case uses a child owner
// whose exit exercises the manager's actual interrupted-record reconciliation.
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-quiet-wait-')));
  const root = path.join(directory, 'state');
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(cwd);
  const manager = new SessionManager({ root });
  const scheduled = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(scheduled);
    await manager.close();
    await fs.rm(directory, { recursive: true, force: true });
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  });

  function later(milliseconds, action) {
    const operation = new Promise(resolve => setTimeout(resolve, milliseconds)).then(action);
    operation.catch(() => {}); // Cleanup observes failures even if an assertion exits early.
    scheduled.push(operation);
    return operation;
  }

  async function add(overrides = {}) {
    const id = randomUUID();
    const jobDirectory = path.join(root, 'jobs', id);
    const file = path.join(jobDirectory, 'job.json');
    await fs.mkdir(jobDirectory, { recursive: true });
    const record = {
      schema_version: 2, job_id: id, assignment_id: `quiet-fixture-${id}`, revision: 1, previous_job_id: null,
      state: 'running', cwd, model: 'swe-2-medium', resolved_model: null, session_id: null,
      runner_pid: process.pid, runner_identity: null, pid: null, process_identity: null,
      started_at: new Date().toISOString(), finished_at: null, cursor: 0, events: [],
      summary: 'Persisted lifecycle fixture; no model was started.', error: null, blockers: [],
      pending_requests: [], checks: [], active_terminals: [], changed_files: null,
      scope_status: 'unknown', out_of_scope: null, task_accepted: false,
      evidence: { completeness: 'unknown', reasons: ['lifecycle_fixture'] },
      source: { base_sha: null, before: null, after: null },
      assignment: { task: 'Local lifecycle fixture only.', role: 'fixture', profile: 'read', owned_paths: [],
        checks: [], resources: [], acceptance: [] },
      preflight: { fixture: true, inference_started: false },
      artifacts: { record: file, directory: jobDirectory, prompt: path.join(jobDirectory, 'unused-prompt.json') },
      locks: [], ...overrides,
    };
    await jsonFile(file, record);
    let writes = Promise.resolve();
    const patch = changes => {
      writes = writes.then(async () => {
        Object.assign(record, typeof changes === 'function' ? changes(structuredClone(record)) : changes);
        await jsonFile(file, record);
        return structuredClone(record);
      });
      return writes;
    };
    return { id, file, record, patch };
  }

  return { directory, root, cwd, manager, add, later };
}

function quietArgs(job, overrides = {}) {
  return { job_id: job.id, mode: 'quiet', after_cursor: 0, wait_seconds: 0, ...overrides };
}

function assertCompact(row, job, { cursor = row.cursor, afterCursor = 0 } = {}) {
  assert.equal(row.job_id, job.id);
  assert.equal(row.mode, 'quiet');
  assert.equal(row.cursor, cursor);
  assert.equal(row.next_cursor, afterCursor, 'quiet waits must not consume progress events');
  assert.equal(row.task_accepted, false);
  assert.match(row.next_token, tokenPattern);
  assert.equal(row.artifacts.record, job.file);
  for (const key of ['summary', 'events', 'preflight', 'assignment', 'runner_pid', 'runner_identity', 'pid', 'process_identity']) {
    assert.equal(Object.hasOwn(row, key), false, `quiet response leaked ${key}`);
  }
}

function assertIdle(row, job, { changed = false, ...options } = {}) {
  assertCompact(row, job, options);
  assert.equal(row.changed, changed);
  assert.equal(row.wake_reason, 'timeout');
  assert.equal(Object.hasOwn(row, 'handoff'), false);
}

function complete(cursor, overrides = {}) {
  return { state: 'completed', cursor, finished_at: new Date().toISOString(),
    summary: 'Lifecycle fixture completed; this is not model task acceptance.',
    events: [{ cursor, type: 'completed', data: { fixture: true } }], ...overrides };
}

test('quiet single waits ignore cursor, text, and tool chatter and retain progress cursor gaps', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const job = await add({ cursor: 100,
    events: Array.from({ length: 11 }, (_, i) => ({ cursor: 90 + i, type: 'agent_message_chunk', data: 'fixture chatter' })),
    summary: 'private fixture chatter '.repeat(10000), preflight: { fixture: true, large: 'x'.repeat(100000) } });
  const initial = await manager.wait(quietArgs(job, { after_cursor: 3 }));
  assertIdle(initial, job, { cursor: 100, afterCursor: 3, changed: true });
  assert.equal(initial.cursor_gap, true);
  const updates = [60, 160, 450].map((ms, i) => later(ms, () => job.patch(record => ({
    cursor: 101 + i, summary: `${record.summary}more fixture progress`,
    events: [...record.events, { cursor: 101 + i, type: i === 1 ? 'tool_call_update' : 'agent_message_chunk', data: { fixture: true } }],
  }))));
  const started = performance.now();
  const result = await manager.wait(quietArgs(job, { after_cursor: 3, after_token: initial.next_token, wait_seconds: 1 }));
  const elapsed = performance.now() - started;
  await Promise.all(updates);
  assert.ok(elapsed >= 850, `ordinary progress woke quiet wait after ${elapsed.toFixed(0)}ms`);
  assertIdle(result, job, { cursor: 103, afterCursor: 3 });
  assert.equal(result.next_token, initial.next_token);
  assert.equal(result.cursor_gap, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8192);
});

test('quiet waits immediately expose permission attention and wake once for a replacement request', posix, async t => {
  const { manager, add, later, cwd } = await fixture(t);
  const request = { request_id: randomUUID(), kind: 'permission', approval_allowed: true,
    command: 'node --version', cwd, check_id: 'fixture-check', reason: 'Explicit local fixture request.',
    created_at: new Date().toISOString(), revision: 1 };
  const job = await add({ state: 'needs_permission', cursor: 4, pending_requests: [request] });
  const first = await manager.wait(quietArgs(job, { wait_seconds: 55 }));
  assertCompact(first, job, { cursor: 4 });
  assert.equal(first.changed, true);
  assert.equal(first.wake_reason, 'attention');
  assert.deepEqual(first.pending_requests, [request]);
  assert.equal(Object.hasOwn(first, 'handoff'), false);

  const replacement = { ...request, request_id: randomUUID(), check_id: 'next-fixture-check' };
  const update = later(120, () => job.patch({ cursor: 5, pending_requests: [replacement] }));
  const started = performance.now();
  const second = await manager.wait(quietArgs(job, { after_token: first.next_token, wait_seconds: 1 }));
  await update;
  assert.ok(performance.now() - started >= 100, 'acknowledged permission busy-woke before its replacement');
  assert.equal(second.changed, true);
  assert.equal(second.wake_reason, 'attention');
  assert.notEqual(second.next_token, first.next_token);
  assert.deepEqual(second.pending_requests, [replacement]);
  const acknowledged = await manager.wait(quietArgs(job, { after_token: second.next_token }));
  assertIdle(acknowledged, job, { cursor: 5 });
  assert.equal(Object.hasOwn(acknowledged, 'pending_requests'), false);
});

test('quiet input attention preserves complete actionable schemas beyond event preview size', posix, async t => {
  const { manager, add } = await fixture(t);
  const schema = { type: 'object', required: ['selection'], properties: { selection: { type: 'string',
    description: 'Fixture field details. '.repeat(350),
    oneOf: Array.from({ length: 24 }, (_, i) => ({ const: `choice-${i}`, title: `Choice ${i} — explicit fixture option.` })) } } };
  assert.ok(Buffer.byteLength(JSON.stringify(schema)) > 6000);
  const request = { request_id: randomUUID(), kind: 'input', message: 'Select the fixture action.',
    schema, allow_other: false, created_at: new Date().toISOString(), revision: 1 };
  const job = await add({ state: 'needs_input', cursor: 8, pending_requests: [request] });
  const result = await manager.wait(quietArgs(job, { wait_seconds: 55 }));
  assertCompact(result, job, { cursor: 8 });
  assert.equal(result.wake_reason, 'attention');
  assert.equal(result.changed, true);
  assert.deepEqual(result.pending_requests, [request]);
  assert.equal(Object.hasOwn(result.pending_requests[0].schema, 'preview'), false);
});

test('quiet terminal lifecycle outcomes hand off once without equating termination to acceptance', posix, async t => {
  const { manager, add } = await fixture(t);
  for (const [index, state] of terminalStates.entries()) {
    const error = state === 'completed' ? null : { code: `FIXTURE_${state.toUpperCase()}`, message: 'Persisted lifecycle fixture outcome.' };
    const job = await add({ ...complete(index + 1), state, error,
      evidence: { completeness: state === 'completed' ? 'complete' : 'incomplete', reasons: ['fixture_only'] } });
    const result = await manager.wait(quietArgs(job, { wait_seconds: 55 }));
    assertCompact(result, job, { cursor: index + 1 });
    assert.equal(result.state, state);
    assert.equal(result.changed, true);
    assert.equal(result.wake_reason, 'terminal');
    assert.equal(result.handoff.task_accepted, false);
    assert.deepEqual(result.handoff.error, error);
    assert.equal(result.handoff.evidence.completeness, job.record.evidence.completeness);
    const acknowledged = await manager.wait(quietArgs(job, { after_token: result.next_token }));
    assertIdle(acknowledged, job, { cursor: index + 1 });
    assert.equal(acknowledged.next_token, result.next_token);
  }
});

test('quiet terminal handoff bounds UTF-8 summary and details while keeping source and check evidence honest', posix, async t => {
  const { manager, add } = await fixture(t);
  const checks = Array.from({ length: 32 }, (_, i) => ({ id: `fixture-check-${i}-${'é'.repeat(108)}`,
    status: i === 0 ? 'stale' : 'unknown', evidence_source: 'bridge_terminal',
    source_binding: i === 0 ? 'changed_after_check' : 'unknown', exit_code: 0 }));
  const source = { base_sha: 'a'.repeat(40), before: { head: 'a'.repeat(40) }, after: { head: 'b'.repeat(40) } };
  const job = await add({ ...complete(4), summary: `${'é🙂\n'.repeat(14000)}TAIL-FIXTURE`, checks, source,
    changed_files: Array.from({ length: 80 }, (_, i) => `src/fixture-${i}-${'é'.repeat(200)}.mjs`),
    scope_status: 'out_of_scope', out_of_scope: ['unexpected-fixture.txt'], output_truncated: true,
    blockers: Array.from({ length: 20 }, (_, i) => ({ code: `FIXTURE_BLOCKER_${i}` })),
    evidence: { completeness: 'incomplete', reasons: Array.from({ length: 12 }, (_, i) => `fixture_reason_${i}`) },
    preflight: { fixture: true, large: 'z'.repeat(100000) } });
  const result = await manager.wait(quietArgs(job));
  assertCompact(result, job, { cursor: 4 });
  assert.equal(result.changed, true);
  assert.ok(Buffer.byteLength(result.handoff.summary) <= 4096);
  assert.equal(result.handoff.summary_truncated, true);
  assert.equal(result.handoff.output_truncated, true);
  assert.ok(result.handoff.summary.endsWith('TAIL-FIXTURE'));
  assert.equal(result.handoff.summary.includes('\ufffd'), false, 'UTF-8 excerpts must not split code points');
  assert.ok(Buffer.byteLength(JSON.stringify(result.handoff)) <= 16384);
  assert.equal(result.handoff.details_truncated, true);
  assert.equal(result.handoff.changed_file_count, 80);
  assert.equal(result.handoff.check_count, 32);
  assert.equal(result.handoff.blocker_count, 20);
  assert.equal(result.handoff.scope_status, 'out_of_scope');
  assert.equal(result.handoff.evidence.completeness, 'incomplete');
  assert.deepEqual(result.handoff.source, { base_sha: source.base_sha, before_head: source.before.head, after_head: source.after.head });
  assert.ok(result.handoff.checks.length > 0);
  assert.equal(result.handoff.checks[0].status, 'stale');
  assert.equal(result.handoff.checks[0].source_binding, 'changed_after_check');
  assert.equal(result.handoff.checks[0].exit_code, 0);
  assert.equal(JSON.parse(await fs.readFile(result.artifacts.record, 'utf8')).summary, job.record.summary);

  const escaped = await add({ ...complete(2), evidence: { completeness: 'incomplete',
    coverage: 'fixture_escaped_metadata', reasons: [], limitations: Array(8).fill('\0'.repeat(512)) } });
  const escapedResult = await manager.wait(quietArgs(escaped));
  assert.ok(Buffer.byteLength(JSON.stringify(escapedResult.handoff)) <= 16384,
    'JSON-escaped diagnostic previews must also fit the serialized handoff limit');
  assert.equal(escapedResult.handoff.details_truncated, true);
  assert.ok(escapedResult.handoff.evidence.limitations.length < 8);
  assert.equal(escapedResult.handoff.evidence.completeness, 'incomplete');

  const started = performance.now();
  const acknowledged = await manager.wait(quietArgs(job, { after_token: result.next_token, wait_seconds: 1 }));
  assert.ok(performance.now() - started >= 850, 'acknowledged completion caused an immediate wake');
  assertIdle(acknowledged, job, { cursor: 4 });
  assert.equal(acknowledged.next_token, result.next_token);
});

test('quiet tokens ignore terminal event chatter but expose new evidence after an acknowledged handoff', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add({ ...complete(3), checks: [{ id: 'fixture-check', status: 'not_run', evidence_source: null }] });
  const initial = await manager.wait(quietArgs(job));
  const acknowledged = await manager.wait(quietArgs(job, { after_token: initial.next_token }));
  assertIdle(acknowledged, job, { cursor: 3 });
  await job.patch({ cursor: 4, events: [{ cursor: 4, type: 'fixture_observation', data: 'unrelated progress event' }] });
  const chatter = await manager.wait(quietArgs(job, { after_token: acknowledged.next_token }));
  assertIdle(chatter, job, { cursor: 4 });
  assert.equal(chatter.next_token, initial.next_token);
  await job.patch({ cursor: 5, checks: [{ id: 'fixture-check', status: 'failed', evidence_source: 'bridge_terminal',
    source_binding: 'matches_final_observed_state', exit_code: 2 }] });
  const changed = await manager.wait(quietArgs(job, { after_token: chatter.next_token }));
  assert.equal(changed.changed, true);
  assert.equal(changed.wake_reason, 'terminal');
  assert.notEqual(changed.next_token, initial.next_token);
  assert.equal(changed.handoff.checks[0].status, 'failed');
});

test('quiet waitMany ignores acknowledged finished targets and progress until another target finishes', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const finished = await add(complete(9));
  const running = await add({ cursor: 2, events: [{ cursor: 2, type: 'agent_message_chunk', data: 'fixture' }] });
  const seen = await manager.wait(quietArgs(finished, { after_cursor: 5 }));
  const active = await manager.wait(quietArgs(running, { after_cursor: 1 }));
  const updates = [
    later(50, () => running.patch({ cursor: 3, summary: 'Routine fixture chatter.', events: [{ cursor: 3, type: 'tool_call_update', data: {} }] })),
    later(300, () => running.patch(complete(4))),
  ];
  const started = performance.now();
  const result = await manager.waitMany({ mode: 'quiet', wait_seconds: 1, jobs: [
    { job_id: finished.id, after_cursor: 5, after_token: seen.next_token },
    { job_id: running.id, after_cursor: 1, after_token: active.next_token },
  ] });
  const elapsed = performance.now() - started;
  await Promise.all(updates);
  assert.ok(elapsed >= 270, `quiet many woke before new completion (${elapsed.toFixed(0)}ms)`);
  assert.equal(result.jobs.length, 2);
  assertIdle(result.jobs[0], finished, { cursor: 9, afterCursor: 5 });
  assert.equal(result.jobs[0].next_token, seen.next_token);
  assertCompact(result.jobs[1], running, { cursor: 4, afterCursor: 1 });
  assert.equal(result.jobs[1].changed, true);
  assert.equal(result.jobs[1].wake_reason, 'terminal');
  assert.ok(result.jobs[1].handoff);
});

test('quiet waitMany returns full new attention and compact per-job load failures', posix, async t => {
  const { manager, add } = await fixture(t);
  const active = await add({ cursor: 3 });
  const request = { request_id: randomUUID(), kind: 'input', message: 'Fixture choice.', revision: 1,
    schema: { type: 'object', properties: { answer: { type: 'string', enum: ['A', 'B'] } }, required: ['answer'] } };
  const attention = await add({ state: 'needs_input', cursor: 7, pending_requests: [request] });
  const result = await manager.waitMany({ mode: 'quiet', wait_seconds: 55, jobs: [
    { job_id: active.id, after_cursor: 3 }, { job_id: attention.id, after_cursor: 2 },
  ] });
  assertIdle(result.jobs[0], active, { cursor: 3, afterCursor: 3, changed: true });
  assertCompact(result.jobs[1], attention, { cursor: 7, afterCursor: 2 });
  assert.equal(result.jobs[1].wake_reason, 'attention');
  assert.deepEqual(result.jobs[1].pending_requests, [request]);

  const missing = randomUUID();
  const failures = await manager.waitMany({ mode: 'quiet', wait_seconds: 55, jobs: [
    { job_id: active.id, after_cursor: 3 }, { job_id: missing, after_cursor: 0 },
  ] });
  assertIdle(failures.jobs[0], active, { cursor: 3, afterCursor: 3, changed: true });
  assert.equal(failures.jobs[1].job_id, missing);
  assert.equal(failures.jobs[1].state, 'error');
  assert.equal(failures.jobs[1].error.code, 'JOB_NOT_FOUND');
  assert.ok(Buffer.byteLength(JSON.stringify(failures.jobs[1])) < 2048);
  await assert.rejects(manager.wait({ job_id: missing, mode: 'quiet', wait_seconds: 0 }), { code: 'JOB_NOT_FOUND' });
});

test('quiet cursor gaps reflect retained history without advancing requested event cursors', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add({ cursor: 14, events: [{ cursor: 10, type: 'fixture' }, { cursor: 14, type: 'fixture' }] });
  for (const [afterCursor, gap] of [[0, true], [8, true], [9, false], [14, false], [99, false]]) {
    const result = await manager.wait(quietArgs(job, { after_cursor: afterCursor }));
    assertIdle(result, job, { cursor: 14, afterCursor, changed: true });
    assert.equal(result.cursor_gap, gap);
  }
  const empty = await add();
  const result = await manager.wait(quietArgs(empty));
  assertIdle(result, empty, { cursor: 0, changed: true });
  assert.equal(result.cursor_gap, false);
});

test('completion near a quiet wait deadline remains observable exactly once', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const job = await add();
  const initial = await manager.wait(quietArgs(job));
  const transition = later(920, () => job.patch(complete(1)));
  let result = await manager.wait(quietArgs(job, { after_token: initial.next_token, wait_seconds: 1 }));
  await transition;
  // If the filesystem transition lands across the timeout snapshot boundary,
  // its returned acknowledgement must still leave completion observable.
  if (result.wake_reason === 'timeout') {
    assert.equal(result.next_token, initial.next_token);
    result = await manager.wait(quietArgs(job, { after_token: result.next_token }));
  }
  assert.equal(result.state, 'completed');
  assert.equal(result.changed, true);
  assert.equal(result.wake_reason, 'terminal');
  assert.ok(result.handoff);
  assertIdle(await manager.wait(quietArgs(job, { after_token: result.next_token })), job, { cursor: 1 });
});

test('default progress waits retain event output and wake on ordinary progress', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const job = await add({ cursor: 2, events: [{ cursor: 1, type: 'fixture_started' }, { cursor: 2, type: 'agent_message_chunk', data: 'fixture text' }] });
  const implicit = await manager.wait({ job_id: job.id, after_cursor: 0, wait_seconds: 0 });
  const explicit = await manager.wait({ job_id: job.id, after_cursor: 0, wait_seconds: 0, mode: 'progress' });
  assert.deepEqual(implicit, explicit);
  assert.equal(implicit.summary, job.record.summary);
  assert.deepEqual(implicit.events, job.record.events);
  assert.equal(implicit.next_cursor, 2);
  assert.ok(implicit.preflight);
  const transition = later(80, () => job.patch({ cursor: 3, events: [...job.record.events, { cursor: 3, type: 'tool_call_update', data: 'fixture progress' }] }));
  const result = await manager.wait({ job_id: job.id, after_cursor: 2 });
  await transition;
  assert.equal(result.state, 'running');
  assert.equal(result.next_cursor, 3);
  assert.deepEqual(result.events, [{ cursor: 3, type: 'tool_call_update', data: 'fixture progress' }]);
  const manyImplicit = await manager.waitMany({ jobs: [{ job_id: job.id, after_cursor: 0 }], wait_seconds: 0 });
  const manyExplicit = await manager.waitMany({ jobs: [{ job_id: job.id, after_cursor: 0 }], mode: 'progress', wait_seconds: 0 });
  assert.deepEqual(manyImplicit, manyExplicit);
});

test('quiet defaults and the 55-second maximum accept prompt completion without long sleeps', posix, async t => {
  const { manager, add, later } = await fixture(t);
  for (const waitSeconds of [undefined, 55]) {
    const job = await add();
    const transition = later(60, () => job.patch(complete(1)));
    const args = { job_id: job.id, mode: 'quiet' };
    if (waitSeconds !== undefined) args.wait_seconds = waitSeconds;
    const result = await manager.wait(args);
    await transition;
    assert.equal(result.state, 'completed');
    assert.equal(result.wake_reason, 'terminal');
    assertCompact(result, job, { cursor: 1 });
  }
  const job = await add();
  const transition = later(60, () => job.patch(complete(1)));
  const result = await manager.waitMany({ jobs: [{ job_id: job.id }], mode: 'quiet' });
  await transition;
  assert.equal(result.jobs[0].wake_reason, 'terminal');
  assertCompact(result.jobs[0], job, { cursor: 1 });
});

test('quiet wait validation rejects invalid modes, tokens, cursors, durations, and target lists', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add();
  for (const mode of ['silent', '', null, 1]) {
    await assert.rejects(manager.wait({ ...quietArgs(job), mode }), { code: 'INVALID_WAIT_MODE' });
    await assert.rejects(manager.waitMany({ jobs: [{ job_id: job.id }], mode, wait_seconds: 0 }), { code: 'INVALID_WAIT_MODE' });
  }
  for (const afterToken of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123, null]) {
    await assert.rejects(manager.wait(quietArgs(job, { after_token: afterToken })), { code: 'INVALID_WAIT_TOKEN' });
    await assert.rejects(manager.waitMany({ jobs: [{ job_id: job.id, after_token: afterToken }], mode: 'quiet', wait_seconds: 0 }), { code: 'INVALID_WAIT_TOKEN' });
  }
  for (const waitSeconds of [-1, 56, 0.5, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(manager.wait(quietArgs(job, { wait_seconds: waitSeconds })), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(manager.waitMany({ jobs: [{ job_id: job.id }], mode: 'quiet', wait_seconds: waitSeconds }), { code: 'INVALID_ARGUMENT' });
  }
  for (const afterCursor of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(manager.wait(quietArgs(job, { after_cursor: afterCursor })), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(manager.waitMany({ jobs: [{ job_id: job.id, after_cursor: afterCursor }], mode: 'quiet', wait_seconds: 0 }), { code: 'INVALID_ARGUMENT' });
  }
  for (const jobs of [[], Array.from({ length: 33 }, () => ({ job_id: randomUUID() })), [{ job_id: job.id }, { job_id: job.id }]]) {
    await assert.rejects(manager.waitMany({ jobs, mode: 'quiet', wait_seconds: 0 }), { code: 'INVALID_WAIT' });
  }
  for (const jobs of [[null], [1], ['not-a-target']]) {
    await assert.rejects(manager.waitMany({ jobs, mode: 'quiet', wait_seconds: 0 }), { code: 'INVALID_WAIT' });
  }
  const maximum = await Promise.all(Array.from({ length: 32 }, () => add(complete(1))));
  const result = await manager.waitMany({ jobs: maximum.map(item => ({ job_id: item.id })), mode: 'quiet', wait_seconds: 0 });
  assert.equal(result.jobs.length, 32);
  for (const row of result.jobs) {
    assert.equal(row.changed, true);
    assert.equal(row.wake_reason, 'terminal');
  }
});

test('aborting one or many quiet waits is prompt and never cancels or rewrites the worker job', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const job = await add();
  const original = await fs.readFile(job.file, 'utf8');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(manager.wait(quietArgs(job, { wait_seconds: 55 }), { signal: aborted.signal }), { code: 'WAIT_CANCELLED' });
  await assert.rejects(manager.waitMany({ jobs: [{ job_id: job.id }], mode: 'quiet', wait_seconds: 55 }, { signal: aborted.signal }), { code: 'WAIT_CANCELLED' });
  for (const many of [false, true]) {
    const controller = new AbortController();
    const cancelled = later(50, () => controller.abort());
    const started = performance.now();
    const operation = many
      ? manager.waitMany({ jobs: [{ job_id: job.id }], mode: 'quiet', wait_seconds: 55 }, { signal: controller.signal })
      : manager.wait(quietArgs(job, { wait_seconds: 55 }), { signal: controller.signal });
    await assert.rejects(operation, { code: 'WAIT_CANCELLED' });
    assert.ok(performance.now() - started < 1500, 'cancelled wait did not settle promptly');
    await cancelled;
    assert.equal(await fs.readFile(job.file, 'utf8'), original);
    await assert.rejects(fs.access(path.join(path.dirname(job.file), 'cancel.json')), { code: 'ENOENT' });
  }
  assert.equal((await manager.load(job.id)).state, 'running');
});

test('manager closure rejects quiet waits without cancelling records owned by another process', posix, async t => {
  const { manager, add, later } = await fixture(t);
  const job = await add();
  const original = await fs.readFile(job.file, 'utf8');
  const one = manager.wait(quietArgs(job, { wait_seconds: 55 }));
  const many = manager.waitMany({ jobs: [{ job_id: job.id }], mode: 'quiet', wait_seconds: 55 });
  const assertions = Promise.all([
    assert.rejects(one, { code: 'BRIDGE_CLOSED' }),
    assert.rejects(many, { code: 'BRIDGE_CLOSED' }),
  ]);
  const closing = later(50, () => manager.close());
  const started = performance.now();
  await assertions;
  assert.ok(performance.now() - started < 1500, 'closed manager left waits active');
  await closing;
  assert.equal(await fs.readFile(job.file, 'utf8'), original);
  await assert.rejects(fs.access(path.join(path.dirname(job.file), 'cancel.json')), { code: 'ENOENT' });
  await assert.rejects(manager.wait(quietArgs(job)), { code: 'BRIDGE_CLOSED' });
});

test('quiet wait observes actual local owner exit as interrupted without replaying work', posix, async t => {
  const { manager, add, later, cwd } = await fixture(t);
  const marker = path.join(cwd, 'preserve.txt');
  await fs.writeFile(marker, 'Preserve this local fixture.\n');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local fixture owner did not become ready.')), 3000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.once('data', data => {
      clearTimeout(timeout);
      if (data.toString().includes('ready')) resolve();
      else reject(new Error('Unexpected local fixture owner readiness output.'));
    });
  });
  const identity = (await exec('ps', ['-p', String(child.pid), '-o', 'pid=,pgid=,lstart=,command='], { timeout: 3000 })).stdout.trim();
  const job = await add({ runner_pid: child.pid, runner_identity: identity });
  const initial = await manager.wait(quietArgs(job));
  assertIdle(initial, job, { changed: true });
  const stopped = later(80, stop);
  const result = await manager.wait(quietArgs(job, { after_token: initial.next_token, wait_seconds: 1 }));
  await stopped;
  assertCompact(result, job, { cursor: 1 });
  assert.equal(result.state, 'interrupted');
  assert.equal(result.changed, true);
  assert.equal(result.wake_reason, 'terminal');
  assert.equal(result.handoff.error.code, 'BRIDGE_INTERRUPTED');
  assert.equal(result.handoff.evidence.completeness, 'incomplete');
  assert.equal(result.handoff.scope_status, 'unknown');
  const persisted = JSON.parse(await fs.readFile(job.file, 'utf8'));
  assert.equal(persisted.workspace_evidence, 'incomplete_after_interruption');
  assert.equal(persisted.session_id, null);
  assert.equal(persisted.pid, null);
  assert.equal(await fs.readFile(marker, 'utf8'), 'Preserve this local fixture.\n');
});
