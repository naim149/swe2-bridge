import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CheckExecutor } from '../src/check-executor.mjs';
import { normalizeAssignment } from '../src/assignment.mjs';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script) => `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sessionId = 'fixture-session';

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-check-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return await fs.realpath(cwd);
}

async function executor(t, cwd, checks, options = {}) {
  const events = [];
  const assignment = await normalizeAssignment({ task: 'Run the declared disposable check.', cwd, profile: 'edit_check', owned_paths: ['marker.txt'], checks });
  const worker = new CheckExecutor({ assignment, directory: path.join(cwd, 'artifacts'), authorize: options.authorize ?? (async () => true), onEvidence: async (event) => {
    events.push(event);
    await options.onEvidence?.(event);
  } });
  t.after(() => worker.close());
  return { worker, events, handlers: worker.handlers, assignment };
}

function gone(pid) {
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
}

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(10);
  }
  assert.fail(`Timed out waiting for fixture ${path.basename(file)}`);
}

test('real command is gated on persisted ownership and returns actual output, status, and artifact hash', async (t) => {
  const cwd = await fixture(t);
  const marker = path.join(cwd, 'marker.txt');
  const command = nodeCommand('require("node:fs").writeFileSync("marker.txt", "executed"); console.log(2+3); console.error("stderr evidence");');
  const { handlers, events } = await executor(t, cwd, [{ id: 'focused', command, timeout_seconds: 10 }], { onEvidence: async (event) => {
    if (event.type === 'terminal_started') {
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
      const persisted = JSON.parse(await fs.readFile(event.artifacts.record, 'utf8'));
      assert.equal(persisted.pid, event.pid);
      assert.equal(persisted.process_identity.marker, event.process_identity.marker);
      await fs.writeFile(path.join(cwd, 'owner-persisted.txt'), event.terminal_id);
    }
  } });
  const created = await handlers['terminal/create']({ sessionId, command, cwd, outputByteLimit: 120000 });
  const params = { sessionId, ...created };
  assert.deepEqual(await handlers['terminal/wait_for_exit'](params), { exitCode: 0, signal: null });
  const output = handlers['terminal/output'](params);
  assert.match(output.output, /5\n/);
  assert.match(output.output, /stderr evidence/);
  assert.equal(output.truncated, false);
  assert.equal(await fs.readFile(marker, 'utf8'), 'executed');
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.outcome, 'completed');
  assert.equal(finished.evidence_complete, true);
  assert.equal(finished.task_accepted, false);
  assert.equal(finished.output_sha256, createHash('sha256').update(await fs.readFile(finished.artifacts.output)).digest('hex'));
  gone(finished.pid);
});

test('undeclared commands, environment changes, wrong cwd, native ownership, and denied approval do not execute', async (t) => {
  const cwd = await fixture(t);
  const other = await fixture(t);
  const command = nodeCommand('require("node:fs").writeFileSync("marker.txt", "must not execute")');
  let authorizations = 0;
  const { handlers, assignment } = await executor(t, cwd, [{ id: 'focused', command }], { authorize: async () => { authorizations++; return false; } });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_PERMISSION_DENIED' });
  assert.equal(authorizations, 1);
  await assert.rejects(handlers['terminal/create']({ sessionId, command: `${command} `, cwd }), { code: 'CHECK_COMMAND_DENIED' });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd, args: ['extra'] }), { code: 'CHECK_ARGUMENTS_DENIED' });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd, env: [{ name: 'PATH', value: '/tmp' }] }), { code: 'CHECK_ARGUMENTS_DENIED' });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd: other }), { code: 'CHECK_COMMAND_DENIED' });
  assignment.checks[0].owner = 'native-builder';
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_NATIVE_OWNER' });
  assignment.checks[0].owner = 'devin';
  assignment.checks.push({ ...assignment.checks[0], id: 'ambiguous', approval: 'ask' });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_COMMAND_DENIED' });
  assignment.profile = 'read';
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_PROFILE_DENIED' });
  await assert.rejects(fs.access(path.join(cwd, 'marker.txt')), { code: 'ENOENT' });
});

test('failed ownership persistence keeps the real command behind its gate', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('require("node:fs").writeFileSync("marker.txt", "must not execute")');
  const { handlers, events } = await executor(t, cwd, [{ id: 'focused', command }], { onEvidence: async (event) => {
    if (event.type === 'terminal_started') throw new Error('Fixture persistence refusal');
  } });
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), /Fixture persistence refusal/);
  await assert.rejects(fs.access(path.join(cwd, 'marker.txt')), { code: 'ENOENT' });
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.execution_gate, 'not_released');
  assert.equal(finished.evidence_complete, false);
  gone(finished.pid);
});

test('per-check deadline stops the real process group and cannot report a passed check', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('console.log("started"); setTimeout(()=>{}, 60000)');
  const { handlers, events } = await executor(t, cwd, [{ id: 'timeout', command, timeout_seconds: 1 }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
  const result = await handlers['terminal/wait_for_exit'](params);
  assert.notEqual(result.signal, null);
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.outcome, 'timed_out');
  assert.equal(finished.evidence_complete, false);
  gone(finished.pid);
});

test('kill cleans up real descendants, release invalidates the terminal, and sessions are isolated', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('const child=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"]);require("node:fs").writeFileSync("marker.txt",String(child.pid));setTimeout(()=>{},60000)');
  const { handlers, events } = await executor(t, cwd, [{ id: 'cancel', command, timeout_seconds: 10 }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
  await waitForFile(path.join(cwd, 'marker.txt'));
  assert.throws(() => handlers['terminal/output']({ ...params, sessionId: 'another-session' }), { code: 'TERMINAL_NOT_FOUND' });
  assert.deepEqual(await handlers['terminal/kill'](params), {});
  assert.deepEqual(await handlers['terminal/kill'](params), {});
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.outcome, 'cancelled');
  gone(finished.pid);
  assert.deepEqual(await handlers['terminal/release'](params), {});
  assert.throws(() => handlers['terminal/output'](params), { code: 'TERMINAL_NOT_FOUND' });
});

test('a successful shell leaving background descendants has cleanup and incomplete evidence', async (t) => {
  const cwd = await fixture(t);
  const command = '/bin/sleep 60 &';
  const { handlers, events } = await executor(t, cwd, [{ id: 'background', command, timeout_seconds: 10 }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
  await handlers['terminal/wait_for_exit'](params);
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.exit_code, 0);
  assert.equal(finished.descendants_terminated, true);
  assert.equal(finished.outcome, 'interrupted');
  assert.equal(finished.evidence_complete, false);
  gone(finished.pid);
});

test('large real UTF-8 output retains a character-safe tail and marks zero-exit evidence unknown', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('console.log("é🙂".repeat(40000))');
  const { handlers, events } = await executor(t, cwd, [{ id: 'large', command }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd, outputByteLimit: 2047 }) };
  assert.equal((await handlers['terminal/wait_for_exit'](params)).exitCode, 0);
  const output = handlers['terminal/output'](params);
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.output) <= 2047);
  assert.equal(output.output.includes('\ufffd'), false);
  assert.ok(output.output.endsWith('é🙂\n'));
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.outcome, 'unknown');
  assert.equal(finished.evidence_complete, false);
  assert.ok((await fs.stat(finished.artifacts.output)).size <= 2047);
});

test('ambient credentials are not copied and lossy output cannot be complete proof', async (t) => {
  const cwd = await fixture(t);
  const oldValue = process.env.SWE2_CHECK_FIXTURE_SENTINEL;
  process.env.SWE2_CHECK_FIXTURE_SENTINEL = 'fixture-private-value';
  t.after(() => {
    if (oldValue === undefined) delete process.env.SWE2_CHECK_FIXTURE_SENTINEL;
    else process.env.SWE2_CHECK_FIXTURE_SENTINEL = oldValue;
  });
  const command = nodeCommand('console.log(String(process.env.SWE2_CHECK_FIXTURE_SENTINEL));process.stdout.write(Buffer.from([255]))');
  const { handlers, events } = await executor(t, cwd, [{ id: 'encoding', command }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
  await handlers['terminal/wait_for_exit'](params);
  assert.match(handlers['terminal/output'](params).output, /^undefined\n/);
  const finished = events.find((event) => event.type === 'terminal_finished');
  assert.equal(finished.output_encoding_lossy, true);
  assert.equal(finished.outcome, 'unknown');
  assert.equal(finished.evidence_complete, false);
});

test('retained output across real checks never exceeds one MiB, including released artifacts', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('process.stdout.write("x".repeat(128*1024))');
  const { handlers, events } = await executor(t, cwd, [{ id: 'bounded', command }]);
  for (let i = 0; i < 32; i++) {
    const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
    await handlers['terminal/wait_for_exit'](params);
    await handlers['terminal/release'](params);
  }
  const finished = events.filter((event) => event.type === 'terminal_finished');
  let bytes = 0;
  for (const event of finished) bytes += (await fs.stat(event.artifacts.output)).size;
  assert.ok(bytes <= 1024 * 1024);
  assert.equal(finished.at(-1).retained_output_bytes, 0);
  assert.equal(finished.at(-1).output_truncated, true);
  assert.equal(finished.at(-1).outcome, 'unknown');
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_LIMIT_REACHED' });
});

test('hard parent termination before releasing the gate never executes the command', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('require("node:fs").writeFileSync("marker.txt", "must not execute")');
  const script = `
    import { promises as fs } from 'node:fs';
    import { CheckExecutor } from ${JSON.stringify(new URL('../src/check-executor.mjs', import.meta.url).href)};
    import { normalizeAssignment } from ${JSON.stringify(new URL('../src/assignment.mjs', import.meta.url).href)};
    const cwd = ${JSON.stringify(cwd)};
    const command = ${JSON.stringify(command)};
    const assignment = await normalizeAssignment({task:'Disposable gate check.',cwd,profile:'edit_check',owned_paths:['marker.txt'],checks:[{id:'crash',command}]});
    const worker = new CheckExecutor({assignment,directory:cwd+'/artifacts',authorize:async()=>true,onEvidence:async(event)=>{
      if(event.type==='terminal_started'){
        await fs.writeFile(cwd+'/ownership.json',JSON.stringify(event));
        process.kill(process.pid,'SIGKILL');
      }
    }});
    await worker.handlers['terminal/create']({sessionId:'crash-fixture',cwd,command});
  `;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: 'ignore' });
  const exit = await new Promise((resolve, reject) => {
    harness.once('error', reject);
    harness.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, 'SIGKILL');
  const ownership = JSON.parse(await fs.readFile(path.join(cwd, 'ownership.json'), 'utf8'));
  const deadline = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(-ownership.pid, 0); await pause(25); }
    catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else if (process.platform === 'darwin' && error.code === 'EPERM') await pause(25);
      else throw error;
    }
  }
  assert.equal(alive, false);
  await assert.rejects(fs.access(path.join(cwd, 'marker.txt')), { code: 'ENOENT' });
});

test('close stops running checks and prevents an authorized pending check from spawning later', async (t) => {
  const cwd = await fixture(t);
  const command = nodeCommand('console.log("started");setTimeout(()=>{},60000)');
  const { worker, handlers, events } = await executor(t, cwd, [{ id: 'close', command, timeout_seconds: 10 }]);
  const params = { sessionId, ...await handlers['terminal/create']({ sessionId, command, cwd }) };
  await worker.close();
  await handlers['terminal/wait_for_exit'](params);
  gone(events[0].pid);
  await assert.rejects(handlers['terminal/create']({ sessionId, command, cwd }), { code: 'CHECK_EXECUTOR_CLOSED' });
  let permit;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  const approval = new Promise((resolve) => { permit = resolve; });
  const pending = await executor(t, cwd, [{ id: 'pending', command }], { authorize: async () => { entered(); return approval; } });
  const creation = pending.handlers['terminal/create']({ sessionId, command, cwd });
  await entering;
  await pending.worker.close();
  permit(true);
  await assert.rejects(creation, { code: 'CHECK_EXECUTOR_CLOSED' });
  assert.deepEqual(pending.events, []);
});
