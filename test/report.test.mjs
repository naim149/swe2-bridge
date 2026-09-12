import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionManager } from '../src/session-manager.mjs';
import { jsonFile } from '../src/runner.mjs';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32' ? 'POSIX-only bridge' : false, timeout: 5000 };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const callerProvenance = 'caller_reported_not_independently_executed';

// Report projections are exercised against explicit durable lifecycle records.
// No Devin executable, ACP connection, model backend, or inference is involved.
// The native-evidence case below does run its declared local Node command.
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-report-')));
  const root = path.join(directory, 'state');
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(cwd);
  const managers = [];
  const open = () => {
    const manager = new SessionManager({ root });
    managers.push(manager);
    return manager;
  };
  const manager = open();
  t.after(async () => {
    await Promise.all(managers.map(item => item.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function add(overrides = {}) {
    const id = randomUUID();
    const jobDirectory = path.join(root, 'jobs', id);
    const file = path.join(jobDirectory, 'job.json');
    await fs.mkdir(jobDirectory, { recursive: true });
    const record = {
      schema_version: 2, job_id: id, assignment_id: `report-fixture-${id}`, revision: 1, previous_job_id: null,
      state: 'completed', stop_reason: 'end_turn', cwd, model: 'swe-2-medium', resolved_model: null,
      session_id: 'persisted-report-fixture-not-an-actual-model-session', runner_pid: process.pid,
      runner_identity: null, pid: null, process_identity: null, started_at: '2026-09-12T00:00:00.000Z',
      finished_at: '2026-09-12T00:00:01.000Z', cursor: 3, events: [],
      summary: 'Retained report fixture answer; no model was started.', output_truncated: false,
      error: null, blockers: [], pending_requests: [], checks: [], active_terminals: [],
      changed_files: [], scope_status: 'within_owned_paths', out_of_scope: [], task_accepted: false,
      evidence: { completeness: 'complete', reasons: [], coverage: 'fixture_record' },
      source: { base_sha: null, before: null, after: null },
      assignment: { task: 'Local durable report fixture.', role: 'fixture', profile: 'read', owned_paths: [],
        checks: [], resources: [], acceptance: [] },
      preflight: { fixture: true, inference_started: false }, locks: [],
      artifacts: { record: file, directory: jobDirectory, before: path.join(jobDirectory, 'before.json'),
        after: path.join(jobDirectory, 'after.json') },
      ...overrides,
    };
    await jsonFile(file, record);
    const patch = async changes => {
      Object.assign(record, changes);
      await jsonFile(file, record);
    };
    return { id, file, record, patch };
  }
  return { directory, root, cwd, manager, open, add };
}

function assertReport(report, job) {
  assert.equal(report.job_id, job.id);
  assert.equal(report.report_available, true);
  assert.equal(report.job_state, job.record.state);
  assert.deepEqual(report.acceptance.status, 'pending_lead_review');
  assert.equal(report.acceptance.task_accepted, false);
  assert.equal(report.artifacts.record, job.file);
  assert.equal(report.answer.text, job.record.summary);
  assert.equal(report.answer.output_truncated, Boolean(job.record.output_truncated));
  for (const key of ['events', 'transcript', 'runner_pid', 'runner_identity', 'pid', 'process_identity']) {
    assert.equal(Object.hasOwn(report, key), false, `report leaked ${key}`);
  }
}

function check(id, status, overrides = {}) {
  return { id, command: 'node --version', status, evidence_source: 'bridge_terminal',
    source_binding: 'matches_final_observed_state', exit_code: status === 'passed' ? 0 : null,
    ...overrides };
}

test('durable reports retain the full answer independently of missing or overwritten progress events', posix, async t => {
  const { manager, open, add } = await fixture(t);
  const answer = `START-FIXTURE\n${'é🙂 retained answer\n'.repeat(900)}END-FIXTURE`;
  assert.ok(Buffer.byteLength(answer) > 4096);
  assert.ok(Buffer.byteLength(answer) <= 32768);
  const job = await add({ state: 'incomplete', summary: answer, output_truncated: true, cursor: 500, events: [] });
  const first = await manager.report({ job_id: job.id });
  assertReport(first, job);
  assert.equal(first.execution.status, 'completed');
  assert.equal(first.verification.status, 'not_declared');
  assert.equal(first.evidence.completeness, 'complete');
  assert.equal(first.policy.status, 'clear');
  assert.equal(first.answer.text.startsWith('START-FIXTURE'), true);
  assert.equal(first.answer.text.endsWith('END-FIXTURE'), true);

  await job.patch({ cursor: 900, events: [{ cursor: 900, type: 'fixture_progress', data: 'Unrelated retained event.' }] });
  const before = await fs.readFile(job.file, 'utf8');
  const second = await manager.report({ job_id: job.id });
  assertReport(second, job);
  assert.equal(second.answer.text, first.answer.text);
  assert.deepEqual(second.execution, first.execution);
  assert.deepEqual(second.evidence, first.evidence);
  assert.equal(await fs.readFile(job.file, 'utf8'), before, 'report retrieval must not rewrite the durable record');
  await manager.close();
  const restarted = open();
  const recovered = await restarted.report({ job_id: job.id });
  assertReport(recovered, job);
  assert.deepEqual(recovered, second);
  assert.deepEqual((await fs.readdir(path.dirname(job.file))).sort(), ['job.json'], 'reports should project the durable record without a duplicate report file');
});

test('denied actions preserve a useful completed answer while remaining explicit policy blocks', posix, async t => {
  const { manager, add } = await fixture(t);
  const blocker = { code: 'ACTION_NOT_DECLARED', message: 'The fixture command was denied.', command: 'fixture-declared-denial' };
  const job = await add({ state: 'blocked', stop_reason: 'end_turn', blockers: [blocker],
    error: { code: 'ACTION_BLOCKED', message: 'Review the blocked action.' },
    summary: 'The useful fixture analysis is retained even though a requested action was denied.' });
  const report = await manager.report({ job_id: job.id });
  assertReport(report, job);
  assert.equal(report.execution.status, 'completed');
  assert.equal(report.policy.status, 'blocked_actions');
  assert.deepEqual(report.policy.blockers, [blocker]);
  assert.equal(report.policy.scope_status, 'within_owned_paths');
  assert.equal(report.evidence.completeness, 'complete');
  assert.equal(report.verification.status, 'not_declared');
});

test('incomplete workspace evidence never becomes clean evidence just because execution ended', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add({ state: 'incomplete', stop_reason: 'end_turn', scope_status: 'unknown', out_of_scope: null,
    changed_files: null, evidence: { completeness: 'incomplete', reasons: ['after_snapshot_missing'], coverage: 'unknown' },
    error: { code: 'WORKSPACE_EVIDENCE_INCOMPLETE', message: 'Fixture after snapshot is unavailable.' } });
  const report = await manager.report({ job_id: job.id });
  assertReport(report, job);
  assert.equal(report.execution.status, 'completed');
  assert.equal(report.evidence.completeness, 'incomplete');
  assert.deepEqual(report.evidence.reasons, ['after_snapshot_missing']);
  assert.equal(report.policy.status, 'unknown');
  assert.equal(report.policy.scope_status, 'unknown');
  assert.equal(report.verification.status, 'not_declared');
});

test('scope violations outrank denied actions and preserve exact out-of-scope evidence', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add({ state: 'blocked', scope_status: 'violated', changed_files: ['owned.txt', 'outside.txt'],
    out_of_scope: ['outside.txt'], blockers: [{ code: 'WRITE_OUT_OF_SCOPE', path: 'outside.txt' }] });
  const report = await manager.report({ job_id: job.id });
  assertReport(report, job);
  assert.equal(report.execution.status, 'completed');
  assert.equal(report.policy.status, 'scope_violation');
  assert.equal(report.policy.scope_status, 'violated');
  assert.deepEqual(report.policy.out_of_scope, ['outside.txt']);
  assert.deepEqual(report.policy.blockers, job.record.blockers);
  await job.patch({ out_of_scope: [], blockers: [] });
  const explicitViolation = await manager.report({ job_id: job.id });
  assert.equal(explicitViolation.policy.status, 'scope_violation');
  assert.equal(explicitViolation.policy.scope_status, 'violated');
});

test('cancellation, deadlines, and interruption take precedence over an earlier end_turn', posix, async t => {
  const { manager, add } = await fixture(t);
  for (const state of ['cancelled', 'timed_out', 'interrupted']) {
    const job = await add({ state, stop_reason: 'end_turn', evidence: { completeness: 'incomplete', reasons: [`fixture_${state}`] },
      error: { code: `FIXTURE_${state.toUpperCase()}`, message: 'Partial fixture result remains inspectable.' } });
    const report = await manager.report({ job_id: job.id });
    assertReport(report, job);
    assert.equal(report.execution.status, state);
    assert.equal(report.evidence.completeness, 'incomplete');
  }
  const failed = await add({ state: 'failed', stop_reason: null,
    error: { code: 'FIXTURE_PROCESS_FAILURE', message: 'Fixture process did not complete.' } });
  const failedReport = await manager.report({ job_id: failed.id });
  assertReport(failedReport, failed);
  assert.equal(failedReport.execution.status, 'failed');
  const notStarted = await add({ state: 'blocked', stop_reason: null, session_id: null, summary: '',
    error: { code: 'CLI_NOT_FOUND', message: 'No CLI or model was started by this fixture.' } });
  const notStartedReport = await manager.report({ job_id: notStarted.id });
  assertReport(notStartedReport, notStarted);
  assert.equal(notStartedReport.execution.status, 'not_started');
});

test('verification distinguishes no checks, incomplete or stale checks, failures, and passed checks', posix, async t => {
  const { manager, add } = await fixture(t);
  const cases = [
    { checks: [], expected: 'not_declared' },
    ...['not_run', 'running', 'stale', 'unknown', 'blocked'].map(status => ({ checks: [check(`fixture-${status}`, status)], expected: 'incomplete' })),
    { checks: [check('fixture-missing-status', undefined)], expected: 'incomplete' },
    { checks: [check('fixture-failed', 'failed', { exit_code: 1 }), check('fixture-stale', 'stale')], expected: 'failed' },
    { checks: [check('fixture-pass-one', 'passed'), check('fixture-pass-two', 'passed')], expected: 'complete' },
  ];
  for (const item of cases) {
    const job = await add({ checks: item.checks });
    const report = await manager.report({ job_id: job.id });
    assertReport(report, job);
    assert.equal(report.verification.status, item.expected);
    assert.equal(report.verification.checks.length, item.checks.length);
    assert.equal(report.execution.status, 'completed');
    assert.equal(report.policy.status, 'clear');
  }
});

test('native verification recorded after a terminal answer remains caller-labeled and durable across managers', posix, async t => {
  const { manager, open, add, cwd } = await fixture(t);
  const script = 'process.stdout.write("actual local report check passed\\n")';
  const command = `${quote(process.execPath)} -e ${quote(script)}`;
  const declared = { id: 'native-fixture-check', command, cwd, owner: 'fixture-native-executor',
    timeout_seconds: 10, approval: 'automatic', status: 'not_run', evidence_source: null,
    native_handoff: { check_id: 'native-fixture-check', owner: 'fixture-native-executor', command, cwd } };
  const job = await add({ checks: [declared] });
  const before = await manager.report({ job_id: job.id });
  assert.equal(before.verification.status, 'incomplete');
  const quietBefore = await manager.wait({ job_id: job.id, mode: 'quiet', wait_seconds: 0 });

  const executed = await exec(process.execPath, ['-e', script], { cwd, timeout: 3000 });
  assert.equal(executed.stderr, '');
  const artifact = path.join(cwd, 'native-check-output.txt');
  await fs.writeFile(artifact, executed.stdout);
  await manager.recordCheck({ job_id: job.id, check_id: declared.id, command, cwd,
    status: 'passed', exit_code: 0, executor: declared.owner, artifact_paths: [artifact] });
  const after = await manager.report({ job_id: job.id });
  assertReport(after, job);
  assert.equal(after.execution.status, 'completed');
  assert.equal(after.verification.status, 'complete');
  const reported = after.verification.checks.find(item => item.id === declared.id);
  assert.equal(reported.native_evidence.status, 'passed');
  assert.equal(reported.native_evidence.provenance, callerProvenance);
  assert.equal(reported.native_evidence.executor, declared.owner);
  assert.equal(reported.native_evidence.exit_code, 0);
  assert.equal(reported.native_evidence.source_sha, null);
  assert.equal(Object.hasOwn(reported.native_evidence, 'artifacts'), false);
  assert.equal(Object.hasOwn(reported.native_evidence, 'command'), false);
  const durable = JSON.parse(await fs.readFile(after.artifacts.record, 'utf8'));
  assert.equal(durable.checks[0].native_evidence.artifacts[0].sha256, createHash('sha256').update(executed.stdout).digest('hex'));
  assert.equal(after.acceptance.task_accepted, false);
  const quietAfter = await manager.wait({ job_id: job.id, mode: 'quiet', wait_seconds: 0, after_token: quietBefore.next_token });
  assert.equal(quietAfter.changed, true);
  assert.equal(quietAfter.wake_reason, 'terminal');

  await manager.close();
  const restarted = open();
  const recovered = await restarted.report({ job_id: job.id });
  assert.deepEqual(recovered, after);
  assert.equal(recovered.verification.checks[0].native_evidence.provenance, callerProvenance);
});

test('reports surface caller-reported native failures without rewriting bridge evidence into a pass', posix, async t => {
  const { manager, add } = await fixture(t);
  const native = { status: 'failed', exit_code: 3, executor: 'fixture-native-executor',
    provenance: callerProvenance, artifacts: [], source_sha: null };
  const job = await add({ checks: [check('mixed-fixture-check', 'not_run', { evidence_source: null, native_evidence: native })] });
  const report = await manager.report({ job_id: job.id });
  assertReport(report, job);
  assert.equal(report.verification.status, 'failed');
  assert.equal(report.verification.checks[0].native_evidence.status, 'failed');
  assert.equal(report.verification.checks[0].native_evidence.exit_code, 3);
  assert.equal(report.verification.checks[0].native_evidence.provenance, callerProvenance);
  assert.equal(report.verification.checks[0].status, 'not_run');
  assert.equal(report.verification.checks[0].evidence_source, null);
});

test('terminal report execution and scope updates invalidate quiet acknowledgments without event changes', posix, async t => {
  const { manager, add } = await fixture(t);
  const job = await add({ state: 'blocked', stop_reason: null });
  const initial = await manager.wait({ job_id: job.id, mode: 'quiet', wait_seconds: 0 });
  assert.equal((await manager.report({ job_id: job.id })).execution.status, 'failed');
  await job.patch({ stop_reason: 'end_turn' });
  const ended = await manager.wait({ job_id: job.id, mode: 'quiet', wait_seconds: 0, after_token: initial.next_token });
  assert.equal(ended.changed, true);
  assert.equal(ended.wake_reason, 'terminal');
  assert.notEqual(ended.next_token, initial.next_token);
  assert.equal((await manager.report({ job_id: job.id })).execution.status, 'completed');

  await job.patch({ out_of_scope: ['late-scope-evidence.txt'] });
  const scope = await manager.wait({ job_id: job.id, mode: 'quiet', wait_seconds: 0, after_token: ended.next_token });
  assert.equal(scope.changed, true);
  assert.equal(scope.wake_reason, 'terminal');
  assert.notEqual(scope.next_token, ended.next_token);
  assert.equal((await manager.report({ job_id: job.id })).policy.status, 'scope_violation');
  assert.equal(scope.cursor, initial.cursor, 'this fixture changes report fields without advancing progress');
});

test('durable reports are terminal-only and missing jobs retain their existing error', posix, async t => {
  const { manager, add } = await fixture(t);
  for (const state of ['starting', 'running', 'needs_permission', 'needs_input', 'finalizing']) {
    const job = await add({ state, stop_reason: null, finished_at: null });
    const original = await fs.readFile(job.file, 'utf8');
    await assert.rejects(manager.report({ job_id: job.id }), { code: 'JOB_ACTIVE' });
    assert.equal(await fs.readFile(job.file, 'utf8'), original);
  }
  await assert.rejects(manager.report({ job_id: randomUUID() }), { code: 'JOB_NOT_FOUND' });
});

test('a real missing-review preflight block retains declared checks and their execution owners', posix, async t => {
  const { manager, cwd } = await fixture(t);
  const git = args => exec('git', args, { cwd, timeout: 3000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--quiet']);
  await fs.writeFile(path.join(cwd, 'fixture.txt'), 'Real local Git review fixture.\n');
  await git(['add', 'fixture.txt']);
  await git(['-c', 'user.name=Bridge fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  // This missing immutable comparison is rejected before the CLI/catalog stage.
  // The declared native command must remain not_run; it is never submitted.
  const result = await manager.run({ assignment_id: randomUUID(), revision: 1, cwd, profile: 'read',
    task: 'Review the explicitly missing local comparison fixture.', base_sha: head,
    review: { base_sha: head, head_sha: 'f'.repeat(40) },
    workspace_trust: 'acknowledged', trust_reason: 'Disposable local Git regression fixture.',
    checks: [{ id: 'declared-native-check', command: 'node --version', cwd, owner: 'fixture-native-executor' }] });
  assert.equal(result.state, 'blocked');
  assert.equal(result.preflight.review.complete, false);
  assert.equal(result.preflight.ready, false);
  const persisted = await manager.load(result.job_id);
  assert.equal(persisted.pid, null);
  assert.equal(persisted.session_id, null);
  assert.equal(persisted.resolved_model, null);
  assert.equal(persisted.prompt_attempted, false);
  const report = await manager.report({ job_id: result.job_id });
  assert.equal(report.execution.status, 'not_started');
  assert.equal(report.verification.status, 'incomplete');
  assert.equal(report.verification.check_count, 1);
  assert.equal(report.verification.checks[0].id, 'declared-native-check');
  assert.equal(report.verification.checks[0].status, 'not_run');
  assert.equal(report.verification.checks[0].owner, 'fixture-native-executor');
  assert.equal(report.verification.checks[0].evidence_source, null);
});

test('existing early-blocked records recover declared checks when runtime check entries are absent', posix, async t => {
  const { manager, add, cwd } = await fixture(t);
  const declared = [
    { id: 'native-declaration', command: 'node --version', cwd, owner: 'fixture-native-executor' },
    { id: 'worker-declaration', command: 'node --help', cwd, owner: 'devin' },
  ];
  for (const checks of [undefined, []]) {
    const job = await add({ state: 'blocked', session_id: null, stop_reason: null, checks,
      preflight: { ready: false },
      assignment: { task: 'Persisted preflight-only fixture.', profile: 'edit_check', checks: declared } });
    const report = await manager.report({ job_id: job.id });
    assertReport(report, job);
    assert.equal(report.execution.status, 'not_started');
    assert.equal(report.verification.status, 'incomplete');
    assert.equal(report.verification.check_count, 2);
    assert.deepEqual(report.verification.checks.map(item => ({ id: item.id, owner: item.owner, status: item.status })),
      declared.map(item => ({ id: item.id, owner: item.owner, status: 'not_run' })));
  }
});

test('a follow-up can inherit a session while its current prompt has never started', posix, async t => {
  const { manager, add } = await fixture(t);
  const cases = [
    { preflight: { ready: false }, prompt_attempted: undefined },
    { preflight: { ready: true }, prompt_attempted: false },
  ];
  for (const fields of cases) {
    const job = await add({ state: 'blocked', revision: 2, previous_job_id: randomUUID(),
      session_id: 'prior-completed-session-fixture', stop_reason: null, ...fields });
    const report = await manager.report({ job_id: job.id });
    assertReport(report, job);
    assert.equal(report.execution.status, 'not_started');
  }
  const attempted = await add({ state: 'failed', revision: 2, session_id: 'prior-completed-session-fixture',
    stop_reason: null, preflight: { ready: true }, prompt_attempted: true });
  assert.equal((await manager.report({ job_id: attempted.id })).execution.status, 'failed');
});

test('legacy completed records retain supported execution evidence and a usable durable record reference', posix, async t => {
  const { manager, add } = await fixture(t);
  const legacy = await add({ schema_version: undefined, revision: undefined, assignment: undefined,
    stop_reason: undefined, preflight: undefined, evidence: undefined, scope_status: undefined,
    out_of_scope: undefined, checks: undefined, exit_code: 0,
    session_id: 'verified-legacy-export-session-fixture', summary: 'Previously retained exported fixture answer.' });
  const { record: unusedRecord, ...legacyArtifacts } = legacy.record.artifacts;
  await legacy.patch({ artifacts: legacyArtifacts });
  const report = await manager.report({ job_id: legacy.id });
  assertReport(report, legacy);
  assert.equal(report.legacy, true);
  assert.equal(report.execution.status, 'completed');
  assert.equal(report.evidence.completeness, 'unknown');
  assert.equal(report.policy.status, 'unknown');
  assert.equal(report.artifacts.record, legacy.file);
  assert.equal(JSON.parse(await fs.readFile(report.artifacts.record, 'utf8')).exit_code, 0);
});
