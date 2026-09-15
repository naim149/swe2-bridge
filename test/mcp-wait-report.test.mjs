import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jsonFile } from '../src/runner.mjs';

const serverFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const managerUrl = new URL('../src/session-manager.mjs', import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const posix = { skip: process.platform === 'win32' ? 'POSIX-only bridge' : false, timeout: 15000 };

async function fixture(t, prepare) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-mcp-wait-report-')));
  const root = path.join(directory, 'state');
  const cwd = path.join(directory, 'workspace');
  const telemetry = path.join(directory, 'wait-observations.jsonl');
  const observer = path.join(directory, 'observe-real-wait.mjs');
  await fs.mkdir(cwd);
  // Test observability only: this preload forwards the real method's original
  // arguments and Promise unchanged. It records actual handler settlement, so
  // client-side cancellation alone cannot falsely establish server cleanup.
  // It does not implement a backend, supply responses, or start inference.
  await fs.writeFile(observer, `
import { appendFileSync } from 'node:fs';
import { SessionManager } from ${JSON.stringify(managerUrl)};
const destination = ${JSON.stringify(telemetry)};
const originalWait = SessionManager.prototype.wait;
let sequence = 0;
let active = 0;
const observe = event => appendFileSync(destination, JSON.stringify(event) + '\\n', { mode: 0o600 });
SessionManager.prototype.wait = function (...args) {
  const id = ++sequence;
  active++;
  observe({ type: 'started', id, active, job_id: args[0]?.job_id, wait_seconds: args[0]?.wait_seconds,
    signal_present: Boolean(args[1]?.signal) });
  const operation = Reflect.apply(originalWait, this, args);
  operation.then(
    () => observe({ type: 'settled', id, active: --active, status: 'fulfilled' }),
    error => observe({ type: 'settled', id, active: --active, status: 'rejected',
      error_code: error?.code ?? null, signal_aborted: Boolean(args[1]?.signal?.aborted) }),
  );
  return operation;
};
`, { mode: 0o600 });

  const env = { DEVIN_BRIDGE_STATE_DIR: root, DEVIN_BRIDGE_MAX_WORKERS: '1',
    DEVIN_CLI_PATH: path.join(directory, 'devin-is-intentionally-unavailable') };
  for (const [key, value] of Object.entries((await prepare?.({ directory, root, cwd })) ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', observer, serverFile], cwd: path.dirname(path.dirname(serverFile)), stderr: 'pipe', env });
  const client = new Client({ name: 'local-wait-report-regression', version: '1.0.0' }, { capabilities: {} });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr = `${stderr}${data.toString()}`.slice(-8192); });
  let pid;
  t.after(async () => {
    pid ??= transport.pid;
    const closeErrors = [];
    try {
      try { await client.close(); } catch (error) { closeErrors.push(error); }
      try { await transport.close(); } catch (error) { closeErrors.push(error); }
      if (pid) {
        const until = performance.now() + 1500;
        while (performance.now() < until) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { pid = null; break; } throw error; }
          await pause(20);
        }
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          assert.fail(`The local MCP server did not exit during cleanup. ${stderr}`);
        }
      }
      if (closeErrors.length) throw closeErrors[0];
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await client.connect(transport, { timeout: 3000 });
  pid = transport.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 1);

  async function add(overrides = {}) {
    const id = randomUUID();
    const jobDirectory = path.join(root, 'jobs', id);
    const file = path.join(jobDirectory, 'job.json');
    await fs.mkdir(jobDirectory, { recursive: true });
    const record = {
      schema_version: 2, job_id: id, assignment_id: `mcp-fixture-${id}`, revision: 1,
      state: 'running', stop_reason: null, cwd, model: 'swe-2-medium', resolved_model: null,
      session_id: null, runner_pid: process.pid, runner_identity: null, pid: null, process_identity: null,
      started_at: new Date().toISOString(), finished_at: null, cursor: 0, events: [],
      summary: 'Local persisted MCP fixture; no model was started.', output_truncated: false,
      error: null, blockers: [], pending_requests: [], checks: [], active_terminals: [], locks: [],
      changed_files: [], out_of_scope: [], scope_status: 'within_owned_paths', task_accepted: false,
      evidence: { completeness: 'complete', reasons: [], coverage: 'fixture_record' },
      source: { base_sha: null, before: null, after: null },
      assignment: { task: 'Local MCP fixture only.', role: 'fixture', profile: 'read', owned_paths: [],
        checks: [], resources: [], acceptance: [] },
      artifacts: { record: file, directory: jobDirectory }, ...overrides,
    };
    await jsonFile(file, record);
    return { id, file, record };
  }
  const readObservations = async () => {
    try { return (await fs.readFile(telemetry, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const observation = async (predicate, label) => {
    const until = performance.now() + 2000;
    do {
      const found = (await readObservations()).find(predicate);
      if (found) return found;
      await pause(20);
    } while (performance.now() < until);
    assert.fail(`Missing server observation: ${label}. ${stderr}`);
  };
  return { client, add, cwd, root, directory, observation, readObservations };
}

function structured(result) {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), result.structuredContent);
  return result.structuredContent;
}

test('real MCP stdio exposes quiet waits and durable reports and releases cancelled wait handlers', posix, async t => {
  const { client, add, cwd, observation, readObservations } = await fixture(t);
  const active = await add();
  const completed = await add({ state: 'blocked', stop_reason: 'end_turn', finished_at: new Date().toISOString(),
    summary: 'Useful retained answer from a completed fixture turn with a denied action.',
    blockers: [{ code: 'ACTION_NOT_DECLARED', message: 'A fixture command was denied.' }],
    error: { code: 'ACTION_BLOCKED', message: 'Inspect the denied fixture action.' } });
  const call = (name, args, options = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 3000, ...options });

  await t.test('tools/list advertises report discovery and quiet wait schema boundaries', async () => {
    const listing = await client.listTools({}, { timeout: 3000 });
    const byName = new Map(listing.tools.map(tool => [tool.name, tool]));
    assert.ok(byName.has('devin_report'));
    assert.equal(byName.get('devin_report').annotations.readOnlyHint, true);
    assert.deepEqual(byName.get('devin_report').inputSchema.required, ['job_id']);
    for (const name of ['devin_wait', 'devin_wait_many']) {
      const properties = byName.get(name).inputSchema.properties;
      assert.equal(properties.wait_seconds.minimum, 0);
      assert.equal(properties.wait_seconds.maximum, 55);
      assert.equal(properties.wait_seconds.default, 10);
      assert.deepEqual(properties.mode.enum, ['progress', 'quiet']);
      assert.equal(properties.mode.default, 'progress');
      const token = name === 'devin_wait' ? properties.after_token : properties.jobs.items.properties.after_token;
      const pattern = new RegExp(token.pattern);
      assert.equal(pattern.test('a'.repeat(64)), true);
      for (const invalid of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) assert.equal(pattern.test(invalid), false);
    }
    const listed = await call('devin_list', {});
    assert.equal(structured(listed).capacity.max_external_workers, 1);
    const tooLong = await call('devin_wait', { job_id: active.id, mode: 'quiet', wait_seconds: 56 });
    assert.equal(tooLong.isError, true);
    const invalidToken = await call('devin_wait', { job_id: active.id, mode: 'quiet', wait_seconds: 0, after_token: 'A'.repeat(64) });
    assert.equal(invalidToken.isError, true);
  });

  await t.test('a completed answer with legacy blocked state is a successful report tool result', async () => {
    const result = await call('devin_report', { job_id: completed.id });
    assert.notEqual(result.isError, true);
    const report = structured(result);
    assert.equal(report.report_available, true);
    assert.equal(report.job_state, 'blocked');
    assert.equal(report.execution.status, 'completed');
    assert.equal(report.policy.status, 'blocked_actions');
    assert.equal(report.answer.text, completed.record.summary);
    assert.equal(report.acceptance.status, 'pending_lead_review');
    assert.equal(report.acceptance.task_accepted, false);
    assert.equal(Object.hasOwn(report, 'events'), false);
  });

  await t.test('SDK cancellation reaches the server wait and leaves the worker and later calls intact', async () => {
    const original = await fs.readFile(active.file, 'utf8');
    const marker = path.join(cwd, 'preserve.txt');
    await fs.writeFile(marker, 'Preserve the local worker fixture.\n');
    const controller = new AbortController();
    const operation = call('devin_wait', { job_id: active.id, mode: 'quiet', wait_seconds: 55, after_cursor: 0,
      after_token: 'a'.repeat(64) }, { signal: controller.signal, timeout: 5000 });
    // Register rejection observation before triggering cancellation. SDK 1.30
    // wraps the local abort reason; the server's own WAIT_CANCELLED is proved
    // separately by the unchanged-method observer below.
    const cancelled = assert.rejects(operation, error => /abort|cancel/i.test(error.message));
    cancelled.catch(() => {}); // Preserve the first failure if observing server startup fails.
    const started = await observation(event => event.type === 'started' && event.job_id === active.id && event.wait_seconds === 55, 'real wait started');
    assert.equal(started.signal_present, true);
    assert.equal(started.active, 1);
    const since = performance.now();
    controller.abort();
    await cancelled;
    const settled = await observation(event => event.type === 'settled' && event.id === started.id, 'cancelled wait settled');
    assert.equal(settled.status, 'rejected');
    assert.equal(settled.error_code, 'WAIT_CANCELLED');
    assert.equal(settled.signal_aborted, true);
    assert.equal(settled.active, 0, 'the server retained a waiting operation after cancellation');
    assert.ok(performance.now() - since < 2000, 'server cancellation did not settle promptly');
    assert.equal(await fs.readFile(active.file, 'utf8'), original);
    assert.equal(await fs.readFile(marker, 'utf8'), 'Preserve the local worker fixture.\n');
    await assert.rejects(fs.access(path.join(path.dirname(active.file), 'cancel.json')), { code: 'ENOENT' });

    const [listing, reported] = await Promise.all([
      client.listTools({}, { timeout: 2000 }),
      call('devin_report', { job_id: completed.id }, { timeout: 2000 }),
    ]);
    assert.ok(listing.tools.some(tool => tool.name === 'devin_wait'));
    assert.notEqual(reported.isError, true);
    assert.equal(structured(reported).answer.text, completed.record.summary);
    const observed = await readObservations();
    const finished = new Set(observed.filter(event => event.type === 'settled').map(event => event.id));
    assert.ok(observed.filter(event => event.type === 'started').every(event => finished.has(event.id)));
    assert.equal(observed.at(-1).active, 0);
  });
});

test('a default-capacity MCP server advertises four shared slots and refuses a fifth run before inference', posix, async t => {
  const { client, cwd, root } = await fixture(t, async ({ directory }) => {
    // Local preflight-only fixture CLI: it answers --version, auth status, and
    // the model catalog so readiness genuinely passes inside the spawned
    // server. It is not a Devin backend; the acp mode is never reached here.
    const cli = path.join(directory, 'fake-devin');
    await fs.writeFile(cli, `#!/bin/sh
case "$1" in
  --version) echo 'devin-fixture 0.0.0';;
  auth) echo 'logged in as fixture@example.invalid';;
  models) echo '{"families":[{"variants":[{"model_uid":"swe-2-medium","label":"Fixture"},{"model_uid":"swe-2-high","label":"Fixture"},{"model_uid":"swe-2-max","label":"Fixture"}]}]}';;
  *) exec sleep 3600;;
esac
`, { mode: 0o700 });
    return { DEVIN_CLI_PATH: cli, DEVIN_BRIDGE_MAX_WORKERS: null };
  });

  await t.test('the advertised shared pool and devin_run description say four', async () => {
    assert.match(client.getInstructions(), /at most four independent jobs/);
    const listing = await client.listTools({}, { timeout: 3000 });
    const run = listing.tools.find(tool => tool.name === 'devin_run');
    assert.match(run.description, /At most four independent bridge jobs share the pool/);
    const listed = structured(await client.callTool({ name: 'devin_list', arguments: {} }, undefined, { timeout: 3000 }));
    assert.equal(listed.capacity.max_external_workers, 4);
  });

  await t.test('four externally held slots refuse a fifth devin_run before inference across processes', async () => {
    for (let i = 0; i < 4; i++) {
      const lock = path.join(root, 'slots', String(i));
      await fs.mkdir(lock, { recursive: true });
      await jsonFile(path.join(lock, 'owner.json'), { job_id: randomUUID(), runner_pid: process.pid, pid: null, pids: [] });
    }
    const result = await client.callTool({ name: 'devin_run', arguments: {
      task: 'Inspect the fixture workspace.', cwd, profile: 'read', assignment_id: randomUUID(), revision: 1,
      workspace_trust: 'acknowledged', trust_reason: 'Disposable local regression fixture.' } }, undefined, { timeout: 10000 });
    assert.equal(result.isError, true);
    const view = structured(result);
    assert.equal(view.state, 'blocked');
    assert.equal(view.error.code, 'WORKER_CAPACITY');
    assert.equal(view.capacity.max_external_workers, 4);
    assert.equal(view.preflight.ready, true);
    assert.equal(view.prompt_attempted, false);
    assert.equal(view.session_id, null);
    assert.equal(view.resolved_model, null);
    for (let i = 0; i < 4; i++) {
      const owner = JSON.parse(await fs.readFile(path.join(root, 'slots', String(i), 'owner.json'), 'utf8'));
      assert.equal(owner.runner_pid, process.pid);
    }
    assert.deepEqual(await fs.readdir(path.join(root, 'locks')), []);
  });
});
