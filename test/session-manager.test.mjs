import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { SessionManager, bindChecksToSource } from '../src/session-manager.mjs';
import { assessChanges, normalizeAssignment, prepareContent } from '../src/assignment.mjs';
import { CheckExecutor } from '../src/check-executor.mjs';
import { JobManager, alive, jsonFile, gitSnapshot } from '../src/runner.mjs';

const exec = promisify(execFile);
const posix = { skip: process.platform === 'win32' ? 'POSIX-only bridge' : false };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-session-regression-'));
  const directory = await fs.realpath(temporary);
  const cwd = path.join(directory, 'repository');
  const root = path.join(directory, 'state');
  await fs.mkdir(cwd);
  const git = args => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Bridge fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  await fs.writeFile(path.join(cwd, 'owned.txt'), 'original owned\n');
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'preserve this\n');
  await git(['add', '.']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const previousCli = process.env.DEVIN_CLI_PATH;
  // This is an unavailable executable, not a fake Devin backend. Every run below
  // must stop in real preflight without starting a model session or inference.
  process.env.DEVIN_CLI_PATH = path.join(directory, 'devin-is-intentionally-unavailable');
  t.after(async () => {
    if (previousCli === undefined) delete process.env.DEVIN_CLI_PATH;
    else process.env.DEVIN_CLI_PATH = previousCli;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, cwd, root, head, git };
}

async function blockedRun(t, overrides = {}) {
  const environment = await fixture(t);
  const manager = new SessionManager({ root: environment.root });
  const args = {
    task: 'Read the disposable fixture.', cwd: environment.cwd,
    profile: 'read', assignment_id: randomUUID(), base_sha: environment.head,
    workspace_trust: 'acknowledged', trust_reason: 'Disposable local regression fixture.',
    ...overrides,
  };
  const result = await manager.run(args);
  assert.equal(result.state, 'blocked');
  assert.equal(result.session_id, null);
  assert.equal(result.resolved_model, null);
  assert.equal(result.task_accepted, false);
  const job = await manager.load(result.job_id);
  assert.equal(job.pid, null);
  t.after(() => manager.close());
  return { ...environment, manager, args, result, job };
}

async function processIdentity(pid) {
  return (await exec('ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart=,command='], { timeout: 3000 })).stdout.trim();
}

async function localGroup(t) {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    if (alive(-child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await exited;
  };
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture child did not become ready.')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', data => {
      clearTimeout(timer);
      if (data.toString().includes('ready')) resolve();
      else reject(new Error('Unexpected fixture child readiness output.'));
    });
  });
  return { child, pid: child.pid, identity: await processIdentity(child.pid), stop, exited };
}

test('stable assignment delivery is deduplicated across managers and restart without inference', posix, async t => {
  const environment = await fixture(t);
  const first = new SessionManager({ root: environment.root });
  const second = new SessionManager({ root: environment.root });
  t.after(async () => { await first.close(); await second.close(); });
  const args = {
    task: 'Read owned.txt.', cwd: environment.cwd, profile: 'read',
    assignment_id: 'durable-duplicate', revision: 1, base_sha: environment.head,
    workspace_trust: 'acknowledged', trust_reason: 'Reviewed disposable fixture.',
  };
  const deliveries = await Promise.all([first.run(args), second.run(args)]);
  assert.equal(deliveries[0].job_id, deliveries[1].job_id);
  assert.ok(deliveries.some(result => result.deduplicated));
  const settled = await first.wait({ job_id: deliveries[0].job_id, wait_seconds: 0 });
  assert.equal(settled.state, 'blocked');
  assert.equal(settled.error.code, 'CLI_NOT_FOUND');
  assert.equal(settled.session_id, null);
  await first.close();
  await second.close();
  const restarted = new SessionManager({ root: environment.root });
  t.after(() => restarted.close());
  const replay = await restarted.run(args);
  assert.equal(replay.job_id, settled.job_id);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.task_accepted, false);
  await assert.rejects(restarted.run({ ...args, task: 'Different work under the same identity.' }), { code: 'ASSIGNMENT_CONFLICT' });
  assert.equal((await fs.readdir(path.join(environment.root, 'jobs'))).length, 1);
  assert.equal(await fs.readFile(path.join(environment.cwd, 'owned.txt'), 'utf8'), 'original owned\n');
});

test('filesystem helpers enforce ownership, read profiles, and real symlink boundaries', posix, async t => {
  const data = await blockedRun(t, { profile: 'edit', owned_paths: ['owned.txt', 'owned-dir/', 'escape.txt', 'linked-dir/', 'alias.txt'] });
  const { manager, job, cwd, directory } = data;
  // Exercise actual scoped filesystem methods on a preflight-blocked fixture;
  // these records never represent a completed model task.
  job.workspace_root = cwd;
  job.attachments = [];
  assert.equal((await manager.readText(job, { path: path.join(cwd, 'owned.txt') })).content, 'original owned\n');
  await manager.writeText(job, { path: path.join(cwd, 'owned.txt'), content: 'authorized update\n' });
  await manager.writeText(job, { path: path.join(cwd, 'owned-dir', 'new.txt'), content: 'new owned file\n' });
  await assert.rejects(manager.writeText(job, { path: path.join(cwd, 'unrelated.txt'), content: 'must not write' }), { code: 'FILE_OUT_OF_SCOPE' });
  assert.equal(await fs.readFile(path.join(cwd, 'unrelated.txt'), 'utf8'), 'preserve this\n');

  const outside = path.join(directory, 'outside.txt');
  await fs.writeFile(outside, 'outside remains unchanged\n');
  await fs.symlink(outside, path.join(cwd, 'escape.txt'));
  await fs.symlink(directory, path.join(cwd, 'linked-dir'));
  await fs.symlink(path.join(cwd, 'unrelated.txt'), path.join(cwd, 'alias.txt'));
  await assert.rejects(manager.readText(job, { path: path.join(cwd, 'escape.txt') }), { code: 'FILE_OUT_OF_SCOPE' });
  for (const file of ['escape.txt', 'linked-dir/new-outside.txt', 'alias.txt']) {
    await assert.rejects(manager.writeText(job, { path: path.join(cwd, file), content: 'must not escape' }), { code: 'FILE_OUT_OF_SCOPE' });
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside remains unchanged\n');
  await assert.rejects(fs.access(path.join(directory, 'new-outside.txt')), { code: 'ENOENT' });

  job.assignment.profile = 'read';
  await assert.rejects(manager.writeText(job, { path: path.join(cwd, 'owned.txt'), content: 'forbidden in read profile' }), { code: 'FILE_OUT_OF_SCOPE' });
  assert.equal((await manager.readText(job, { path: path.join(cwd, 'owned.txt') })).content, 'authorized update\n');
  assert.equal(job.task_accepted, false);
  assert.ok(job.blockers.some(blocker => blocker.code === 'WRITE_OUT_OF_SCOPE'));
});

test('filesystem helpers return full bounded contents and reject oversized files and writes', posix, async t => {
  const { manager, job, cwd } = await blockedRun(t, { profile: 'edit', owned_paths: ['owned.txt'] });
  job.workspace_root = cwd;
  const content = 'é'.repeat(1024 * 1024);
  await fs.writeFile(path.join(cwd, 'owned.txt'), content);
  assert.equal((await manager.readText(job, { path: path.join(cwd, 'owned.txt') })).content, content);
  await assert.rejects(manager.writeText(job, { path: path.join(cwd, 'owned.txt'), content: `${content}x` }), { code: 'FILE_WRITE_LIMIT' });
  assert.equal(await fs.readFile(path.join(cwd, 'owned.txt'), 'utf8'), content);
  await fs.appendFile(path.join(cwd, 'owned.txt'), 'x');
  await assert.rejects(manager.readText(job, { path: path.join(cwd, 'owned.txt') }), { code: 'FILE_READ_LIMIT' });
});

test('an owned file with an unowned or external hard link cannot be modified', posix, async t => {
  const { manager, job, cwd, directory } = await blockedRun(t, { profile: 'edit', owned_paths: ['owned.txt'] });
  job.workspace_root = cwd;
  const owned = path.join(cwd, 'owned.txt');
  for (const alias of [path.join(cwd, 'unowned-hardlink.txt'), path.join(directory, 'outside-hardlink.txt')]) {
    await fs.link(owned, alias);
    assert.equal((await fs.stat(owned)).nlink, 2);
    await assert.rejects(manager.writeText(job, { path: owned, content: 'must not alter aliases\n' }), { code: 'MULTILINK_WRITE_DENIED' });
    assert.equal(await fs.readFile(alias, 'utf8'), 'original owned\n');
    assert.equal(await fs.readFile(owned, 'utf8'), 'original owned\n');
    await fs.unlink(alias);
  }
});

test('real check evidence becomes stale after later edits and unknown for changed or missing source', posix, async t => {
  const scripts = [
    'const fs = require("node:fs"); if (fs.readFileSync("owned.txt", "utf8") !== "original owned\\n") process.exit(1); console.log("check passed");',
    'require("node:fs").writeFileSync("owned.txt", "changed by check\\n"); console.log("check made a declared fixture change");',
  ];
  const commands = scripts.map(script => `${quote(process.execPath)} -e ${quote(script)}`);
  const { manager, job, cwd } = await blockedRun(t, { profile: 'edit_check', owned_paths: ['owned.txt'],
    checks: commands.map((command, i) => ({ id: `source-check-${i}`, command, owner: 'devin' })) });
  job.checks = job.assignment.checks.map(check => ({ ...check, status: 'not_run', evidence_source: null }));
  const executor = new CheckExecutor({ assignment: job.assignment, directory: job.artifacts.directory,
    authorize: async () => true, onEvidence: evidence => manager.checkEvidence(job, evidence) });
  try {
    const first = await executor.create({ sessionId: 'local-regression-no-model-session', command: commands[0], cwd });
    const firstParams = { sessionId: 'local-regression-no-model-session', terminalId: first.terminalId };
    assert.equal((await executor.waitForExit(firstParams)).exitCode, 0);
    assert.match((await executor.output(firstParams)).output, /check passed/);
    await executor.release(firstParams);
    const unchanged = await gitSnapshot(cwd);
    bindChecksToSource(job.checks, unchanged);
    const firstEvidence = job.checks[0];
    assert.equal(firstEvidence.status, 'passed');
    assert.equal(firstEvidence.source_binding, 'matches_final_observed_state');
    assert.equal(firstEvidence.exit_code, 0);
    assert.equal(firstEvidence.source_before.complete, true);
    assert.equal(firstEvidence.source_after.complete, true);

    const missingAfter = structuredClone(firstEvidence);
    bindChecksToSource([missingAfter], null);
    assert.equal(missingAfter.status, 'unknown');
    assert.equal(missingAfter.source_binding, 'unknown');
    assert.equal(missingAfter.exit_code, 0);
    const missingBefore = structuredClone(firstEvidence);
    delete missingBefore.source_before;
    bindChecksToSource([missingBefore], unchanged);
    assert.equal(missingBefore.status, 'unknown');
    assert.equal(missingBefore.source_binding, 'changed_or_unknown_during_check');
    assert.equal(missingBefore.exit_code, 0);

    await fs.writeFile(path.join(cwd, 'owned.txt'), 'later implementation edit\n');
    bindChecksToSource(job.checks, await gitSnapshot(cwd));
    assert.equal(firstEvidence.status, 'stale');
    assert.equal(firstEvidence.source_binding, 'changed_after_check');
    assert.equal(firstEvidence.exit_code, 0);

    const second = await executor.create({ sessionId: 'local-regression-no-model-session', command: commands[1], cwd });
    const secondParams = { sessionId: 'local-regression-no-model-session', terminalId: second.terminalId };
    assert.equal((await executor.waitForExit(secondParams)).exitCode, 0);
    await executor.release(secondParams);
    bindChecksToSource(job.checks, await gitSnapshot(cwd));
    assert.equal(job.checks[1].status, 'unknown');
    assert.equal(job.checks[1].source_binding, 'changed_or_unknown_during_check');
    assert.equal(job.checks[1].exit_code, 0);
    assert.equal(await fs.readFile(path.join(cwd, 'owned.txt'), 'utf8'), 'changed by check\n');
    assert.equal(job.state, 'blocked');
    assert.equal(job.task_accepted, false);
    assert.equal(job.session_id, null);
  } finally { await executor.close(); }
});

test('encoded image attachments are rejected before exceeding the ACP frame budget', posix, async t => {
  const { cwd, directory } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b9sAAAAASUVORK5CYII=', 'base64');
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  png.copy(bytes);
  const attachments = [];
  for (const name of ['reference-a.png', 'reference-b.png']) {
    const file = path.join(directory, name);
    await fs.writeFile(file, bytes);
    attachments.push({ path: file, mime_type: 'image/png' });
  }
  const base = { task: 'Inspect explicit image references.', cwd, profile: 'read' };
  const single = await prepareContent(await normalizeAssignment({ ...base, attachments: attachments.slice(0, 1) }));
  assert.equal(single.attachments[0].size_bytes, 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(single.content)) < 8 * 1024 * 1024);
  await assert.rejects(prepareContent(await normalizeAssignment({ ...base, attachments })), { code: 'ACP_CONTENT_LIMIT' });
});

test('native check recording preserves concurrent evidence and rejects ownership/source mismatches', posix, async t => {
  const commands = ['first-native', 'second-native'].map(label => `${quote(process.execPath)} -e ${quote(`console.log(${JSON.stringify(label)})`)}`);
  const data = await blockedRun(t, { profile: 'edit_check', owned_paths: ['owned.txt'], checks: commands.map((command, i) => ({ id: `check-${i}`, command, owner: 'native-tester' })) });
  const { manager, job, cwd, head, root, directory } = data;
  // Declare not-run native checks on an actual preflight-blocked record. Native
  // proof below comes from real local child processes, never a fake model reply.
  job.checks = job.assignment.checks.map(check => ({ ...check, status: 'not_run', evidence_source: null }));
  const before = await gitSnapshot(cwd);
  const reports = [];
  for (let i = 0; i < commands.length; i++) {
    const execution = await exec('/bin/sh', ['-c', commands[i]], { cwd, timeout: 5000 });
    const artifact = path.join(directory, `native-check-${i}.txt`);
    await fs.writeFile(artifact, execution.stdout);
    reports.push({ job_id: job.job_id, check_id: `check-${i}`, command: commands[i], executor: 'native-tester',
      status: 'passed', exit_code: 0, cwd, source_sha: head, artifact_paths: [artifact] });
  }
  Object.assign(job, assessChanges(before, await gitSnapshot(cwd), job.assignment));
  await manager.save(job);
  const other = new SessionManager({ root });
  t.after(() => other.close());
  await Promise.all([manager.recordCheck(reports[0]), other.recordCheck(reports[1])]);
  const persisted = await other.load(job.job_id);
  assert.equal(persisted.state, 'blocked');
  assert.equal(persisted.task_accepted, false);
  for (let i = 0; i < reports.length; i++) {
    const evidence = persisted.checks.find(check => check.id === `check-${i}`).native_evidence;
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.executor, 'native-tester');
    assert.equal(evidence.provenance, 'caller_reported_not_independently_executed');
    const bytes = await fs.readFile(reports[i].artifact_paths[0]);
    assert.equal(evidence.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(persisted.events.filter(event => event.type === 'native_check_recorded').length, 2);
  await assert.rejects(manager.recordCheck({ ...reports[0], executor: 'different-owner' }), error => /executor|owner/i.test(error.code || error.message));
  await fs.mkdir(path.join(cwd, 'other-directory'));
  await assert.rejects(manager.recordCheck({ ...reports[0], cwd: path.join(cwd, 'other-directory') }), error => /cwd|directory/i.test(error.code || error.message));
  const wrongSha = (head.startsWith('0') ? '1' : '0') + head.slice(1);
  await assert.rejects(manager.recordCheck({ ...reports[0], source_sha: wrongSha }), error => /source|sha/i.test(error.code || error.message));
});

test('a real owner exit during persisted finalization reconciles to unknown evidence', posix, async t => {
  const { manager, job } = await blockedRun(t);
  const owner = await localGroup(t);
  Object.assign(job, { state: 'finalizing', runner_pid: owner.pid, runner_identity: owner.identity, changed_files: ['stale-observation.txt'] });
  await manager.save(job);
  assert.equal((await manager.load(job.job_id)).state, 'finalizing');
  await owner.stop();
  const interrupted = await manager.load(job.job_id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.error.code, 'BRIDGE_INTERRUPTED');
  assert.equal(interrupted.evidence.completeness, 'incomplete');
  assert.equal(interrupted.scope_status, 'unknown');
  assert.equal(interrupted.changed_files, null);
  assert.equal(interrupted.task_accepted, false);
  assert.equal(interrupted.session_id, null);
});

test('a surviving real check process retains the shared lock until identity-checked cancellation', posix, async t => {
  const { manager, job, root, cwd } = await blockedRun(t);
  const owner = await localGroup(t);
  const command = await localGroup(t);
  const lock = path.join(root, 'locks', createHash('sha256').update(cwd).digest('hex'));
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await manager.locker.acquire(lock, job.job_id);
  Object.assign(job, { state: 'finalizing', runner_pid: owner.pid, runner_identity: owner.identity,
    locks: [lock], active_terminals: [{ terminal_id: 'real-local-check', pid: command.pid, process_identity: command.identity }] });
  await manager.save(job);
  // Omit lock.pids deliberately: durable job evidence must still protect a
  // surviving command when a crash occurred before the lock record was updated.
  await jsonFile(path.join(lock, 'owner.json'), { job_id: job.job_id, runner_pid: owner.pid, pid: null });
  await owner.stop();
  const competitor = new JobManager();
  competitor.root = root;
  const nextJobId = randomUUID();
  await assert.rejects(competitor.acquire(lock, nextJobId), { code: 'WORKSPACE_BUSY' });
  assert.equal(alive(-command.pid), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).job_id, job.job_id);
  const recovered = await manager.cancel(job.job_id);
  await command.exited;
  assert.equal(alive(-command.pid), false);
  assert.equal(recovered.state, 'cancelled');
  assert.equal(recovered.evidence.completeness, 'incomplete');
  assert.equal(recovered.task_accepted, false);
  await competitor.acquire(lock, nextJobId);
  await competitor.release(lock, nextJobId);
});
