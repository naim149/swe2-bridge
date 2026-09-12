import { spawn } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { childEnvironment } from './runner.mjs';

const TERMINAL_BYTES = 128 * 1024;
const TOTAL_BYTES = 1024 * 1024;
const MAX_CHECKS = 32;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const GATED_SHELL = [
  'IFS= read -r _swe2_gate || exit 125',
  '[ "$_swe2_gate" = "$2" ] || exit 125',
  '/bin/sh -c "$1" "$0"',
  '_swe2_status=$?',
  'exit "$_swe2_status"',
].join('\n');

function fault(code, message) {
  return Object.assign(new Error(message), { code, state: 'blocked', retryable: false });
}

function groupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function groupGone(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (groupAlive(pid) && Date.now() < deadline) await pause(25);
  return !groupAlive(pid);
}

async function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (process.platform === 'darwin' && error.code === 'EPERM' && await groupGone(pid, 500)) return;
    throw error;
  }
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fault('CHECK_CLEANUP_PENDING', message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function writeJson(file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readRetainedOutput(file, expectedBytes) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedBytes || stat.size > TERMINAL_BYTES) throw new Error('Retained output file changed unexpectedly.');
    const bytes = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes) throw new Error('Retained output file grew or shrank while being inspected.');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function tailUtf8(value, byteLimit) {
  if (!byteLimit) return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= byteLimit) return value;
  let start = bytes.length - byteLimit;
  // The string was decoded before truncation, so skip continuation bytes to
  // preserve a complete UTF-8 character at the retained output boundary.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function sessionId(params) {
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 256) {
    throw fault('INVALID_TERMINAL_SESSION', 'Terminal requests require the ACP sessionId.');
  }
  return params.sessionId;
}

/** Execute only declared checks, through ACP's client-owned terminal surface. */
export class CheckExecutor {
  constructor({ assignment, directory, onEvidence, authorize }) {
    if (!assignment || !Array.isArray(assignment.checks)) throw new TypeError('CheckExecutor requires a normalized assignment.');
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('CheckExecutor directory must be absolute.');
    if (typeof onEvidence !== 'function' || typeof authorize !== 'function') throw new TypeError('CheckExecutor requires onEvidence and authorize callbacks.');
    this.assignment = assignment;
    this.directory = path.resolve(directory);
    this.onEvidence = onEvidence;
    this.authorize = authorize;
    this.terminals = new Map();
    this.starts = 0;
    this.starting = 0;
    this.retainedBytes = 0;
    this.closed = false;
    this.closeOperation = null;
  }

  get handlers() {
    return {
      'terminal/create': (params) => this.create(params),
      'terminal/output': (params) => this.output(params),
      'terminal/release': (params) => this.release(params),
      'terminal/wait_for_exit': (params) => this.waitForExit(params),
      'terminal/kill': (params) => this.kill(params),
    };
  }

  async match(params) {
    const session_id = sessionId(params);
    if (this.assignment.profile !== 'edit_check') throw fault('CHECK_PROFILE_DENIED', 'This assignment profile does not authorize shell commands.');
    if (typeof params.command !== 'string' || !params.command || params.command.includes('\0')) throw fault('CHECK_COMMAND_DENIED', 'Supply one exact declared command string.');
    for (const key of ['args', 'env']) {
      if (params[key] !== undefined && (!Array.isArray(params[key]) || params[key].length)) {
        throw fault('CHECK_ARGUMENTS_DENIED', 'Separate terminal args or environment overrides are not authorized by this assignment.');
      }
    }
    const requestedCwd = params.cwd ?? this.assignment.cwd;
    if (typeof requestedCwd !== 'string' || !path.isAbsolute(requestedCwd)) throw fault('CHECK_CWD_DENIED', 'A terminal cwd must be absolute.');
    let cwd;
    try {
      cwd = await fs.realpath(requestedCwd);
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Not a directory');
    } catch { throw fault('CHECK_CWD_DENIED', 'The terminal working directory cannot be established.'); }
    const candidates = this.assignment.checks.filter((candidate) => candidate.command === params.command && candidate.cwd === cwd);
    if (candidates.length !== 1) throw fault('CHECK_COMMAND_DENIED', 'The exact command and canonical directory must identify one unambiguous declared check.');
    const check = candidates[0];
    if (check.owner != null && check.owner !== 'devin') throw fault('CHECK_NATIVE_OWNER', `Check ${check.id} belongs to its named native executor.`);
    const outputByteLimit = params.outputByteLimit ?? TERMINAL_BYTES;
    if (!Number.isSafeInteger(outputByteLimit) || outputByteLimit < 0) throw fault('INVALID_TERMINAL_LIMIT', 'outputByteLimit must be a nonnegative integer.');
    if (!Number.isInteger(check.timeout_seconds) || check.timeout_seconds < 1 || check.timeout_seconds > 600) throw fault('INVALID_CHECK_TIMEOUT', 'The declared check deadline must be between 1 and 600 seconds.');
    return { session_id, check, cwd, limit: Math.min(outputByteLimit, TERMINAL_BYTES) };
  }

  create(params) {
    if (this.closed) return Promise.reject(fault('CHECK_EXECUTOR_CLOSED', 'The check executor is shutting down.'));
    if (this.starts + this.starting >= MAX_CHECKS) return Promise.reject(fault('CHECK_LIMIT_REACHED', 'This assignment has reached its limit of 32 terminal checks.'));
    this.starting++;
    return this.start(params).finally(() => { this.starting--; });
  }

  async start(params) {
    if (process.platform === 'win32') throw fault('PLATFORM_UNSUPPORTED', 'Check terminals require POSIX process groups.');
    const { session_id, check, cwd, limit } = await this.match(params);
    if (await this.authorize(check, { ...params, cwd }) !== true) throw fault('CHECK_PERMISSION_DENIED', 'The declared check was not explicitly authorized.');
    if (this.closed) throw fault('CHECK_EXECUTOR_CLOSED', 'The check executor closed before this command was started.');
    const id = randomUUID();
    const directory = path.join(this.directory, 'checks', id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const artifacts = { output: path.join(directory, 'output.log'), record: path.join(directory, 'terminal.json') };
    await fs.writeFile(artifacts.output, '', { mode: 0o600 });
    if (this.closed) throw fault('CHECK_EXECUTOR_CLOSED', 'The check executor closed before this command was started.');
    const marker = `swe2-bridge-check-${id}`;
    const gateToken = randomUUID();
    const started_at = new Date().toISOString();
    const child = spawn('/bin/sh', ['-c', GATED_SHELL, marker, check.command, gateToken], {
      cwd, env: childEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const terminal = {
      id, session_id, check, cwd, child, pid: child.pid ?? null, started_at, artifacts,
      process_identity: { marker, group_pid: child.pid ?? null, runner_pid: process.pid, started_at },
      limit, output: '', retained_bytes: 0, observed_bytes: 0, truncated: false, encoding_lossy: false,
      streamHash: createHash('sha256'), exit_status: null, stop_reason: null, error: null,
      descendants_terminated: false, group_remaining: false, finished: false, released: false,
      writeRequested: false, writeOperation: null, writeError: null, finishing: null, stopping: null,
      gate_released: false,
    };
    terminal.done = new Promise((resolve, reject) => { terminal.resolveDone = resolve; terminal.rejectDone = reject; });
    terminal.done.catch(() => {});
    terminal.processClosed = new Promise((resolve) => { terminal.resolveClosed = resolve; });
    terminal.spawned = new Promise((resolve) => { terminal.resolveSpawned = resolve; });
    this.terminals.set(id, terminal);
    this.starts++;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      const validator = new TextDecoder('utf-8', { fatal: true });
      stream.on('data', (bytes) => {
        terminal.observed_bytes += bytes.length;
        terminal.streamHash.update(bytes);
        try { validator.decode(bytes, { stream: true }); } catch { terminal.encoding_lossy = true; }
        this.capture(terminal, decoder.write(bytes));
      });
      stream.once('end', () => {
        try { validator.decode(); } catch { terminal.encoding_lossy = true; }
        this.capture(terminal, decoder.end());
      });
    }
    child.stdin.on('error', (error) => {
      if (!terminal.stop_reason && !terminal.exit_status) terminal.error ??= { code: 'CHECK_GATE_FAILED', message: error.code ?? 'stdin failed' };
    });
    child.once('spawn', () => terminal.resolveSpawned(true));
    child.once('error', (error) => {
      terminal.error ??= { code: 'CHECK_SPAWN_FAILED', message: error.code ?? 'spawn failed' };
      terminal.resolveSpawned(false);
    });
    child.once('exit', (exitCode, signal) => {
      terminal.exit_status = { exitCode, signal };
      this.finish(terminal);
    });
    child.once('close', (exitCode, signal) => {
      terminal.exit_status ??= { exitCode, signal };
      terminal.resolveClosed();
      this.finish(terminal);
    });
    terminal.timer = setTimeout(() => { void this.stop(terminal, 'timed_out').catch((error) => {
      terminal.error ??= { code: error.code ?? 'CHECK_CLEANUP_FAILED', message: error.message };
    }); }, check.timeout_seconds * 1000);
    terminal.timer.unref();
    try {
      if (!await terminal.spawned) throw fault('CHECK_SPAWN_FAILED', 'The declared check could not start its gated shell.');
      const event = this.startedEvent(terminal);
      await writeJson(artifacts.record, event);
      // The shell is waiting on its pipe. Closing this process before this
      // evidence persists closes the pipe, so the command never runs.
      await this.onEvidence(event);
      if (this.closed || terminal.stop_reason || terminal.exit_status) throw fault('CHECK_START_CANCELLED', 'The check stopped before its command was released.');
      terminal.gate_released = true;
      await new Promise((resolve, reject) => child.stdin.end(`${gateToken}\n`, (error) => error ? reject(error) : resolve()));
      return { terminalId: id };
    } catch (error) {
      terminal.error ??= { code: error.code ?? 'CHECK_START_FAILED', message: error.message };
      child.stdin.destroy();
      await this.stop(terminal, terminal.stop_reason ?? 'start_failed').catch((cleanupError) => {
        terminal.error = { code: cleanupError.code ?? 'CHECK_CLEANUP_FAILED', message: cleanupError.message };
      });
      throw error;
    }
  }

  startedEvent(terminal) {
    return {
      type: 'terminal_started', terminal_id: terminal.id, session_id: terminal.session_id,
      check_id: terminal.check.id, command: terminal.check.command, cwd: terminal.cwd,
      pid: terminal.pid, process_identity: terminal.process_identity,
      started_at: terminal.started_at, timeout_seconds: terminal.check.timeout_seconds,
      approval: terminal.check.approval, artifacts: terminal.artifacts,
      execution_gate: 'awaiting_durable_ownership', task_accepted: false,
    };
  }

  capture(terminal, text) {
    if (!text || terminal.finished) return;
    const previous = terminal.retained_bytes;
    const budget = Math.min(terminal.limit, previous + Math.max(0, TOTAL_BYTES - this.retainedBytes));
    const combined = terminal.output + text;
    terminal.output = tailUtf8(combined, budget);
    terminal.retained_bytes = Buffer.byteLength(terminal.output);
    this.retainedBytes += terminal.retained_bytes - previous;
    if (Buffer.byteLength(combined) > terminal.retained_bytes) terminal.truncated = true;
    terminal.writeRequested = true;
    this.flush(terminal);
  }

  flush(terminal) {
    if (terminal.writeOperation) return terminal.writeOperation;
    terminal.writeOperation = (async () => {
      while (terminal.writeRequested) {
        terminal.writeRequested = false;
        await fs.writeFile(terminal.artifacts.output, terminal.output, { mode: 0o600 });
      }
    })().catch((error) => {
      terminal.writeError ??= { code: 'CHECK_OUTPUT_WRITE_FAILED', message: error.code ?? 'output persistence failed' };
      terminal.error ??= terminal.writeError;
      if (!terminal.exit_status) void this.stop(terminal, 'output_failed').catch(() => {});
    }).finally(() => { terminal.writeOperation = null; });
    return terminal.writeOperation;
  }

  finish(terminal) {
    if (terminal.finishing) return terminal.finishing;
    terminal.finishing = this.finalize(terminal).then(() => terminal.resolveDone(), (error) => {
      terminal.error ??= { code: error.code ?? 'CHECK_FINALIZATION_FAILED', message: error.message };
      terminal.rejectDone(error);
    });
    return terminal.finishing;
  }

  async finalize(terminal) {
    clearTimeout(terminal.timer);
    if (groupAlive(terminal.pid)) {
      if (!terminal.stop_reason) terminal.descendants_terminated = true;
      await this.terminateGroup(terminal);
    }
    await bounded(terminal.processClosed, 5000, 'The check process streams have not closed after group cleanup.');
    await this.flush(terminal);
    const actualOutput = Buffer.from(terminal.output);
    let persistedHash = null;
    try {
      const persisted = await readRetainedOutput(terminal.artifacts.output, actualOutput.length);
      persistedHash = createHash('sha256').update(persisted).digest('hex');
      if (persisted.length !== actualOutput.length || !persisted.equals(actualOutput)) terminal.error ??= { code: 'CHECK_OUTPUT_MISMATCH', message: 'Retained output differs from its persisted artifact.' };
    } catch (error) { terminal.error ??= { code: 'CHECK_OUTPUT_UNAVAILABLE', message: error.code ?? 'output unreadable' }; }
    terminal.group_remaining = groupAlive(terminal.pid);
    let outcome;
    if (terminal.stop_reason === 'timed_out') outcome = 'timed_out';
    else if (['cancelled', 'released', 'executor_closed'].includes(terminal.stop_reason)) outcome = 'cancelled';
    else if (terminal.group_remaining || terminal.descendants_terminated) outcome = 'interrupted';
    else if (terminal.exit_status?.exitCode !== 0) outcome = 'failed';
    else if (terminal.error || terminal.truncated || terminal.encoding_lossy) outcome = 'unknown';
    else outcome = 'completed';
    terminal.finished_at = new Date().toISOString();
    terminal.event = {
      ...this.startedEvent(terminal), type: 'terminal_finished', execution_gate: terminal.gate_released ? 'released' : 'not_released',
      finished_at: terminal.finished_at, exit_code: terminal.exit_status?.exitCode ?? null, signal: terminal.exit_status?.signal ?? null,
      outcome, evidence_complete: !terminal.error && !terminal.truncated && !terminal.encoding_lossy && !terminal.group_remaining && !terminal.descendants_terminated && !terminal.stop_reason,
      output_truncated: terminal.truncated, output_encoding_lossy: terminal.encoding_lossy, observed_output_bytes: terminal.observed_bytes, retained_output_bytes: terminal.retained_bytes,
      output_sha256: persistedHash, observed_stream_sha256: terminal.streamHash.digest('hex'),
      stop_reason: terminal.stop_reason, descendants_terminated: terminal.descendants_terminated,
      process_group_gone: !terminal.group_remaining, error: terminal.error,
    };
    await writeJson(terminal.artifacts.record, terminal.event);
    await this.onEvidence(terminal.event);
    terminal.finished = true;
    if (terminal.group_remaining) throw fault('CHECK_PROCESS_GROUP_REMAINS', 'An owned check process group remains after cleanup.');
  }

  async terminateGroup(terminal) {
    if (terminal.terminating) return terminal.terminating;
    terminal.terminating = (async () => {
      await signalGroup(terminal.pid, 'SIGTERM');
      if (!await groupGone(terminal.pid, 1000)) {
        await signalGroup(terminal.pid, 'SIGKILL');
        if (!await groupGone(terminal.pid, 3000)) throw fault('CHECK_PROCESS_GROUP_REMAINS', 'An owned check process group remains; retain its identity and inspect before continuing.');
      }
    })().finally(() => { terminal.terminating = null; });
    return terminal.terminating;
  }

  async stop(terminal, reason) {
    if (terminal.finished && !groupAlive(terminal.pid)) return;
    if (terminal.stopping) return terminal.stopping;
    if (!terminal.exit_status) terminal.stop_reason ??= reason;
    terminal.child.stdin.destroy();
    terminal.stopping = (async () => {
      await this.terminateGroup(terminal);
      await bounded(terminal.done, 5000, 'Check termination or final evidence is still pending.');
      if (groupAlive(terminal.pid)) throw fault('CHECK_PROCESS_GROUP_REMAINS', 'An owned check process group remains after stopping it.');
    })().finally(() => { terminal.stopping = null; });
    return terminal.stopping;
  }

  lookup(params) {
    const requestedSession = sessionId(params);
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal || terminal.released || terminal.session_id !== requestedSession) throw fault('TERMINAL_NOT_FOUND', 'No active terminal identifier exists in this ACP session.');
    return terminal;
  }

  output(params) {
    const terminal = this.lookup(params);
    return { output: terminal.output, truncated: terminal.truncated, ...(terminal.finished ? { exitStatus: terminal.exit_status } : {}) };
  }

  async waitForExit(params) {
    const terminal = this.lookup(params);
    await terminal.done;
    return terminal.exit_status;
  }

  async kill(params) {
    await this.stop(this.lookup(params), 'cancelled');
    return {};
  }

  async release(params) {
    const terminal = this.lookup(params);
    await this.stop(terminal, 'released');
    terminal.released = true;
    terminal.output = '';
    return {};
  }

  close() {
    this.closed = true;
    if (this.closeOperation) return this.closeOperation;
    this.closeOperation = (async () => {
      const results = await Promise.allSettled([...this.terminals.values()].map((terminal) => this.stop(terminal, 'executor_closed')));
      const remaining = [...this.terminals.values()].filter((terminal) => groupAlive(terminal.pid));
      if (remaining.length) throw fault('CHECK_PROCESS_GROUP_REMAINS', `${remaining.length} owned check process group(s) remain; preserve their recorded identities.`);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })().catch((error) => { this.closeOperation = null; throw error; });
    return this.closeOperation;
  }
}
