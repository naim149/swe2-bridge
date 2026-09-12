import { promises as fs, constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.mjs';
import { CheckExecutor } from './check-executor.mjs';
import { normalizeAssignment, prepareContent, inspectReadiness, assessChanges, matchesOwnedPath } from './assignment.mjs';
import { JobManager, fault, jsonFile, alive, signalGroup, groupGone, gitSnapshot, snapshotEvidence } from './runner.mjs';

const exec = promisify(execFile);
const terminal = new Set(['completed', 'blocked', 'failed', 'cancelled', 'timed_out', 'interrupted', 'incomplete']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const stamp = () => new Date().toISOString();
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const internal = Symbol('runtime');
const MAX_EVENTS = 256;
const TEXT_LIMIT = 32 * 1024;
export const MAX_WAIT_SECONDS = 55;
const MAX_HANDOFF_BYTES = 16 * 1024;

function clippedText(value, limit, tail = false) {
  const bytes = Buffer.from(String(value ?? ''));
  if (bytes.length <= limit) return bytes.toString('utf8');
  let start = tail ? bytes.length - limit : 0;
  let end = tail ? bytes.length : limit;
  if (tail) while ((bytes[start] & 0xc0) === 0x80) start++;
  else while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(start, end).toString('utf8');
}

function declaredChecks(assignment) {
  return (assignment?.checks || []).map(check => ({ ...check, status: 'not_run', evidence_source: null,
    native_handoff: check.owner && check.owner !== 'devin' || assignment.profile !== 'edit_check'
      ? { check_id: check.id, owner: check.owner || 'native_executor', command: check.command, cwd: check.cwd,
        reason: 'Assigned native ownership or execution profile' } : null }));
}

function reportChecks(job) {
  // Earlier v0.2 jobs initialized checks only after preflight. Preserve their
  // declared work in reports even when startup stopped before that point.
  return job.checks?.length ? job.checks : declaredChecks(job.assignment);
}

function finalHandoff(job) {
  const files = job.changed_files;
  const checks = reportChecks(job);
  const summary = clippedText(job.summary, 4096, true);
  const result = {
    summary, summary_truncated: summary !== (job.summary || ''), output_truncated: Boolean(job.output_truncated),
    error: job.error ? { code: clippedText(job.error.code, 128), message: clippedText(job.error.message, 1024) } : null,
    blocker_codes: [...new Set((job.blockers || []).map(item => clippedText(item.code, 128)))].slice(0, 16),
    blocker_count: job.blockers?.length || 0,
    changed_files: Array.isArray(files) ? files.slice(0, 16).map(file => clippedText(file, 256)) : null,
    changed_file_count: Array.isArray(files) ? files.length : null,
    scope_status: job.scope_status ?? 'unknown',
    checks: checks.map(check => ({ id: check.id, status: check.status,
      owner: check.owner ?? check.native_handoff?.owner ?? (job.assignment?.profile === 'edit_check' ? 'devin' : null),
      evidence_source: check.evidence_source ?? null,
      source_binding: check.source_binding ?? null,
      exit_code: check.exit_code ?? check.native_evidence?.exit_code ?? null,
      ...(check.native_evidence ? { native_status: check.native_evidence.status } : {}) })),
    check_count: checks.length,
    evidence: { completeness: job.evidence?.completeness ?? 'unknown',
      reasons: (job.evidence?.reasons || []).slice(0, 8).map(reason => clippedText(reason, 128)),
      coverage: clippedText(job.evidence?.coverage ?? 'unknown', 256),
      limitations: (job.evidence?.limitations || []).slice(0, 8).map(limit => clippedText(limit, 512)) },
    source: { base_sha: job.source?.base_sha ?? null, before_head: job.source?.before?.head ?? null, after_head: job.source?.after?.head ?? null },
    task_accepted: false,
  };
  result.details_truncated = Boolean(
    files?.length > 16 || files?.some(file => Buffer.byteLength(file) > 256) ||
    (job.blockers?.length || 0) > 16 || (job.evidence?.reasons?.length || 0) > 8 ||
    job.evidence?.reasons?.some(reason => Buffer.byteLength(String(reason)) > 128) ||
    (job.evidence?.limitations?.length || 0) > 8 || job.evidence?.limitations?.some(limit => Buffer.byteLength(String(limit)) > 512) ||
    Buffer.byteLength(job.evidence?.coverage ?? '') > 256 ||
    job.error && JSON.stringify(result.error) !== JSON.stringify(job.error));
  // Bound even unusually long identifiers and JSON-escaped text. The full
  // durable record remains available; this handoff is never task acceptance.
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_HANDOFF_BYTES) {
    result.details_truncated = true;
    if (result.changed_files?.length) result.changed_files.pop();
    else if (result.checks.length) result.checks.pop();
    else if (result.summary) {
      result.summary = clippedText(result.summary, Math.floor(Buffer.byteLength(result.summary) / 2), true);
      result.summary_truncated = true;
    } else if (result.blocker_codes.length) result.blocker_codes.pop();
    else if (result.evidence.limitations.length) result.evidence.limitations.pop();
    else if (result.evidence.reasons.length) result.evidence.reasons.pop();
    else break; // All remaining fields have small, assignment-enforced bounds.
  }
  return result;
}

function outcomes(job, state = job.state) {
  const checks = reportChecks(job);
  const checkStates = checks.map(check => check.native_evidence?.status ?? check.status);
  const legacyCompleted = job.schema_version !== 2 && state === 'completed' && job.exit_code === 0 && job.session_id;
  const execution = ['cancelled', 'timed_out', 'interrupted'].includes(state) ? state
    : job.stop_reason === 'end_turn' || legacyCompleted ? 'completed'
      : job.stop_reason === 'refusal' ? 'refused'
        : job.prompt_attempted === false || job.preflight?.ready === false || !job.session_id && !job.stop_reason ? 'not_started'
          : ['failed', 'blocked'].includes(state) ? 'failed' : terminal.has(state) ? 'incomplete' : 'running';
  const verification = !checks.length ? 'not_declared'
    : checkStates.includes('failed') ? 'failed'
      : checkStates.every(value => value === 'passed') ? 'complete' : 'incomplete';
  const policy = job.out_of_scope?.length || job.scope_status === 'violated' ? 'scope_violation'
    : job.blockers?.length ? 'blocked_actions'
      : job.scope_status !== 'within_owned_paths' ? 'unknown' : 'clear';
  return { execution: { status: execution, stop_reason: job.stop_reason ?? null, prompt_attempted: job.prompt_attempted ?? null },
    evidence: { completeness: job.evidence?.completeness ?? 'unknown' },
    verification: { status: verification }, policy: { status: policy },
    acceptance: { status: 'pending_lead_review', task_accepted: false } };
}

function waitOptions({ mode = 'progress', wait_seconds = 10, after_cursor = 0, after_token } = {}) {
  if (!['progress', 'quiet'].includes(mode)) throw fault('INVALID_WAIT_MODE', 'Use progress or quiet wait mode.');
  if (after_token !== undefined && (typeof after_token !== 'string' || !/^[a-f0-9]{64}$/.test(after_token))) {
    throw fault('INVALID_WAIT_TOKEN', 'Use the next_token returned by a quiet wait.');
  }
  return { mode, seconds: integer(wait_seconds, 10, MAX_WAIT_SECONDS, 'wait_seconds'),
    cursor: integer(after_cursor, 0, Number.MAX_SAFE_INTEGER, 'after_cursor'), token: after_token };
}

function waitCancelled(signal) {
  if (signal?.aborted) throw fault('WAIT_CANCELLED', 'This wait was cancelled; the worker job was not cancelled.');
}

function waitDelay(ms, signal) {
  waitCancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort);
      reject(fault('WAIT_CANCELLED', 'This wait was cancelled; the worker job was not cancelled.')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function beneath(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function processIdentity(pid) {
  if (!pid) return null;
  try { return (await exec('ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart=,command='], { timeout: 3000, maxBuffer: 16384 })).stdout.trim(); }
  catch { return null; }
}

function integer(value, fallback, max, label) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw fault('INVALID_ARGUMENT', `${label} must be an integer from 0 to ${max}.`);
  return value;
}

function bounded(value, limit = 6000) {
  const encoded = JSON.stringify(value);
  return encoded.length <= limit ? value : { truncated: true, preview: encoded.slice(0, limit) };
}

async function readBounded(handle, limit, code) {
  const buffer = Buffer.alloc(limit + 1);
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, null);
    if (!bytesRead) break;
    read += bytesRead;
  }
  if (read > limit) throw fault(code, 'The file grew beyond its declared byte limit.');
  return buffer.subarray(0, read);
}

export function bindChecksToSource(checks, after) {
  const finalHash = after ? digest(snapshotEvidence(after)) : null;
  for (const check of checks) {
    if (check.evidence_source !== 'bridge_terminal') continue;
    if (!check.source_after?.complete || !finalHash) {
      check.source_binding = 'unknown';
      if (check.status === 'passed') check.status = 'unknown';
    } else if (check.source_after.snapshot_sha256 !== finalHash) {
      check.source_binding = 'changed_after_check';
      if (check.status === 'passed') check.status = 'stale';
    } else if (!check.source_before?.complete || check.source_before.snapshot_sha256 !== check.source_after.snapshot_sha256) {
      check.source_binding = 'changed_or_unknown_during_check';
      if (check.status === 'passed') check.status = 'unknown';
    } else check.source_binding = 'matches_final_observed_state';
  }
}

/** Durable assignments over real Devin ACP sessions. No routing policy lives here. */
export class SessionManager {
  constructor({ root, maxWorkers } = {}) {
    this.root = path.resolve(root || process.env.DEVIN_BRIDGE_STATE_DIR || path.join(os.homedir(), '.local/share/devin-bridge'));
    this.maxWorkers = Number(maxWorkers ?? process.env.DEVIN_BRIDGE_MAX_WORKERS ?? 3);
    if (!Number.isInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 3) throw fault('INVALID_CAPACITY', 'DEVIN_BRIDGE_MAX_WORKERS must be from 1 to 3.');
    this.defaultModel = process.env.DEVIN_BRIDGE_MODEL || 'swe-2-medium';
    this.locker = new JobManager();
    this.locker.root = this.root;
    this.jobs = new Map();
    this.starting = new Set();
    this.closed = false;
  }

  describe() {
    return { backend: 'devin_acp', default_model: this.defaultModel, max_external_workers: this.maxWorkers,
      worker_budget_owner: 'caller_counts_native_and_external_workers', state_directory: this.root,
      filesystem_sandbox: false, exact_models_only: true };
  }

  async preflight(args) {
    const assignment = await normalizeAssignment(args, { defaultModel: this.defaultModel });
    const result = await inspectReadiness(assignment);
    if (!result.ready && result.review?.complete === false) return { ...result, capacity: this.describe() };
    const prepared = await prepareContent(assignment);
    return { ...result, attachments: prepared.attachments, required_capabilities: prepared.required_capabilities, capacity: this.describe() };
  }

  run(args) {
    const operation = this.start(args);
    this.starting.add(operation);
    operation.finally(() => this.starting.delete(operation)).catch(() => {});
    return operation;
  }

  async lookupIntent(assignment, intentHash) {
    const index = path.join(this.root, 'assignments', digest(assignment.assignment_id), `${assignment.revision}.json`);
    try {
      const existing = await readJson(index);
      if (existing.intent_hash !== intentHash) throw fault('ASSIGNMENT_CONFLICT', 'This assignment ID/revision already names different work. Use devin_message with the next revision.');
      return this.view(await this.load(existing.job_id), 0, true);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }

  async start(args, previous = null) {
    if (this.closed) throw fault('BRIDGE_CLOSED', 'The bridge is shutting down.');
    const assignment = await normalizeAssignment(args, { defaultModel: this.defaultModel });
    assignment.assignment_id ??= randomUUID();
    const intentHash = digest(assignment);
    const duplicate = await this.lookupIntent(assignment, intentHash);
    if (duplicate) return duplicate;
    if ((!previous && assignment.revision !== 1) || (previous && assignment.revision !== previous.revision + 1)) {
      throw fault('INVALID_REVISION', 'Start at revision 1; follow-ups use devin_message and the consecutive revision.');
    }
    const jobId = randomUUID();
    const guard = path.join(this.root, 'assignment-locks', digest(assignment.assignment_id));
    await fs.mkdir(path.dirname(guard), { recursive: true, mode: 0o700 });
    let guarded = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await this.locker.acquire(guard, jobId); guarded = true; break; }
      catch (error) {
        if (error.code !== 'WORKSPACE_BUSY') throw error;
        const duplicate = await this.lookupIntent(assignment, intentHash);
        if (duplicate) return duplicate;
        await delay(100);
      }
    }
    if (!guarded) throw fault('ASSIGNMENT_STARTING', 'This assignment is being started by another bridge. Retry the same ID/revision or discover it with devin_list; do not change its identity.');
    const locks = [];
    let job;
    try {
      const duplicate = await this.lookupIntent(assignment, intentHash);
      if (duplicate) return duplicate;
      const directory = path.join(this.root, 'jobs', jobId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      job = {
        schema_version: 2, job_id: jobId, assignment_id: assignment.assignment_id, revision: assignment.revision,
        previous_job_id: previous?.job_id ?? null, assignment, intent_hash: intentHash,
        state: 'starting', cwd: assignment.cwd, model: assignment.model, resolved_model: null,
        session_id: previous?.session_id ?? null, session_resumed: Boolean(previous), runner_pid: process.pid,
        runner_identity: await processIdentity(process.pid), pid: null, process_identity: null,
        started_at: stamp(), finished_at: null, cursor: 0, events: [], output_truncated: false,
        summary: '', error: null, blockers: [], pending_requests: [], checks: declaredChecks(assignment), active_terminals: [],
        prompt_attempted: false,
        ...(assignment.review ? { review: { ...assignment.review, complete: false } } : {}),
        changed_files: null, scope_status: 'unknown', task_accepted: false,
        artifacts: { directory, record: path.join(directory, 'job.json'), before: path.join(directory, 'before.json'),
          after: path.join(directory, 'after.json'), before_diff: path.join(directory, 'before.diff'),
          after_diff: path.join(directory, 'after.diff'), stderr: path.join(directory, 'stderr.log'),
          prompt: path.join(directory, 'prompt.json') },
        locks,
      };
      job[internal] = { save: Promise.resolve(), requests: new Map(), toolCalls: new Map(), grants: new Map(), fsOperations: new Set(), loading: true, finalizing: false };
      this.jobs.set(jobId, job);
      await this.save(job);
      const indexDir = path.join(this.root, 'assignments', digest(assignment.assignment_id));
      await fs.mkdir(indexDir, { recursive: true, mode: 0o700 });
      await jsonFile(path.join(indexDir, `${assignment.revision}.json`), { job_id: jobId, intent_hash: intentHash, previous_job_id: job.previous_job_id });
      const readiness = await inspectReadiness(assignment);
      job.preflight = readiness;
      if (readiness.review) job.review = readiness.review;
      if (!readiness.ready) throw fault(readiness.blockers[0]?.code || 'PREFLIGHT_BLOCKED', readiness.blockers.map(item => item.message).join(' '));
      const prepared = await prepareContent(assignment);
      if (readiness.review?.packet_sha256 && readiness.review.packet_sha256 !== prepared.review?.packet_sha256) {
        throw fault('REVIEW_EVIDENCE_CHANGED', 'The comparison packet changed after preflight. No prompt was submitted.');
      }
      job.attachments = prepared.attachments;
      if (prepared.review) job.review = prepared.review;
      job.required_capabilities = prepared.required_capabilities;
      const checkout = readiness.source.repository || assignment.cwd;
      const requestedLocks = [path.join(this.root, 'locks', digest(checkout)),
        ...assignment.resources.filter(item => item.owner === 'devin').map(item => path.join(this.root, 'resource-locks', digest(item.name)))];
      for (const lock of requestedLocks.sort()) {
        await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
        await this.locker.acquire(lock, jobId);
        locks.push(lock);
      }
      await fs.mkdir(path.join(this.root, 'slots'), { recursive: true, mode: 0o700 });
      let slot;
      for (let i = 0; i < this.maxWorkers; i++) {
        const lock = path.join(this.root, 'slots', String(i));
        try { await this.locker.acquire(lock, jobId); slot = i; locks.push(lock); break; }
        catch (error) { if (error.code !== 'WORKSPACE_BUSY') throw error; }
      }
      if (slot === undefined) throw fault('WORKER_CAPACITY', 'All configured external worker slots are occupied. The caller must also count its native workers.');
      job.slot = slot;
      const baseline = await gitSnapshot(assignment.cwd, { review: Boolean(assignment.review) });
      if (assignment.base_sha && baseline.head !== assignment.base_sha) throw fault('SOURCE_CHANGED', 'Git HEAD changed after preflight. No prompt was submitted.');
      job[internal].baseline = snapshotEvidence(baseline);
      await Promise.all([
        jsonFile(job.artifacts.before, snapshotEvidence(baseline)),
        fs.writeFile(job.artifacts.before_diff, baseline.diff, { mode: 0o600 }),
        fs.writeFile(path.join(directory, 'before-staged.diff'), baseline.staged_diff, { mode: 0o600 }),
        jsonFile(job.artifacts.prompt, prepared.content),
      ]);
      job.workspace_root = baseline.repository || assignment.cwd;
      await this.event(job, 'starting', { session_resumed: Boolean(previous), slot });
      if (this.closed) throw fault('BRIDGE_CLOSED', 'The bridge closed before inference started.');
      // The initial record and retry identity exist before a prompt can be sent.
      job[internal].done = this.execute(job, prepared.content).catch(async error => {
        job.state = 'interrupted'; job.error = { code: 'FINALIZATION_FAILED', message: error.message };
        await this.save(job);
      });
      return this.view(job);
    } catch (error) {
      if (!job) throw error;
      job.state = error.state || 'blocked'; job.error = { code: error.code || 'START_FAILED', message: error.message };
      job.finished_at = stamp();
      await this.event(job, 'blocked', job.error);
      for (const lock of locks.reverse()) await this.locker.release(lock, jobId);
      job[internal].finished = true;
      this.jobs.delete(jobId);
      return this.view(job);
    } finally { await this.locker.release(guard, jobId); }
  }

  async execute(job, content) {
    const runtime = job[internal];
    runtime.executor = new CheckExecutor({ assignment: job.assignment, directory: job.artifacts.directory,
      authorize: (check, params) => this.authorizeCheck(job, check, params),
      onEvidence: evidence => this.checkEvidence(job, evidence) });
    runtime.client = new AcpClient({ executable: job.preflight.cli.path, cwd: job.cwd, model: job.model,
      stderrPath: job.artifacts.stderr,
      onUpdate: params => this.update(job, params),
      onPermission: (params, context) => this.permission(job, params, context),
      requestHandlers: {
        ...runtime.executor.handlers,
        'fs/read_text_file': (params, context) => this.fileOperation(job, 'readText', params, context),
        'fs/write_text_file': (params, context) => this.fileOperation(job, 'writeText', params, context),
        'elicitation/create': (params, context) => this.elicitation(job, params, context),
      },
    });
    try {
      const initialized = await runtime.client.start();
      job.pid = runtime.client.pid;
      job.process_identity = await processIdentity(job.pid);
      if (!job.process_identity) throw fault('PROCESS_IDENTITY_UNVERIFIED', 'Cannot persist the worker process identity before inference.');
      job.capabilities = initialized.agentCapabilities;
      await this.updateLocks(job);
      await this.save(job);
      const session = job.session_resumed ? await runtime.client.loadSession(job.session_id) : await runtime.client.newSession();
      job.session_id = session.sessionId;
      job.resolved_model = job.model; // AcpClient verifies the exact selected model from session metadata.
      await runtime.client.setMode(job.session_id, job.assignment.profile === 'read' ? 'ask' : 'accept-edits');
      runtime.loading = false;
      job.state = 'running';
      await this.event(job, 'session_ready', { session_id: job.session_id, resolved_model: job.resolved_model, mode: job.assignment.profile === 'read' ? 'ask' : 'accept-edits' });
      if (runtime.stopReason || this.closed) throw fault('WORKER_STOPPED', 'The worker was stopped before its prompt.');
      runtime.timer = setTimeout(() => { void this.stop(job, 'timed_out').catch(() => {}); }, job.assignment.timeout_seconds * 1000);
      runtime.control = setInterval(() => { void this.controls(job).catch(error => { job.error ||= { code: 'CONTROL_FAILED', message: error.message }; }); }, 200);
      job.prompt_attempted = true;
      const result = await runtime.client.prompt(job.session_id, content, { timeoutMs: Math.min(3_600_000, job.assignment.timeout_seconds * 1000 + 5000) });
      job.stop_reason = result.stopReason;
      job.state = runtime.stopReason || (result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'refusal' ? 'blocked' : 'incomplete');
      if (job.state === 'completed' && !job.summary.trim()) {
        job.state = 'incomplete'; job.error = { code: 'RESULT_UNVERIFIED', message: 'The turn ended without a terminal answer.' };
      }
      if (result.stopReason === 'refusal') job.error = { code: 'MODEL_REFUSAL', message: 'The selected model declined this turn. No fallback was selected.' };
    } catch (error) {
      job.state = runtime.stopReason || (error.code === 'ACP_TIMEOUT' ? 'timed_out' : error.state || 'blocked');
      job.error = { code: error.code || 'ACP_FAILED', message: error.message.slice(0, 4000) };
    } finally {
      let finalState = job.state;
      runtime.finalizing = true;
      job.state = 'finalizing';
      await this.save(job);
      clearTimeout(runtime.timer); clearInterval(runtime.control);
      for (const request of runtime.requests.values()) request.resolve({ decision: 'deny' });
      job.pending_requests = [];
      let stopped = true;
      for (const resource of [runtime.executor, runtime.client]) {
        try { await resource.close(); }
        catch (error) { stopped = false; finalState = 'interrupted'; job.error = { code: 'PROCESS_GROUP_REMAINS', message: error.message }; }
      }
      await Promise.allSettled([...runtime.fsOperations]);
      job.output_truncated ||= Boolean(runtime.client.stats.stderrTruncated || runtime.client.stats.updatesTruncated);
      let after;
      try {
        after = await gitSnapshot(job.cwd, { review: Boolean(job.assignment.review) });
        await Promise.all([jsonFile(job.artifacts.after, snapshotEvidence(after)),
          fs.writeFile(job.artifacts.after_diff, after.diff, { mode: 0o600 }),
          fs.writeFile(path.join(job.artifacts.directory, 'after-staged.diff'), after.staged_diff, { mode: 0o600 })]);
      } catch (error) { job.error ||= { code: 'WORKSPACE_EVIDENCE_INCOMPLETE', message: error.message }; }
      Object.assign(job, assessChanges(runtime.baseline, after, job.assignment));
      bindChecksToSource(job.checks, after);
      if (finalState === 'completed' && (job.evidence.completeness !== 'complete' || job.output_truncated)) finalState = 'incomplete';
      if (job.out_of_scope?.length || job.blockers.length) {
        if (finalState === 'completed') finalState = 'blocked';
        job.error ||= { code: job.out_of_scope?.length ? 'SCOPE_VIOLATION' : 'ACTION_BLOCKED', message: 'Review the scope evidence and blocked actions before continuing.' };
      }
      if (runtime.stopReason) job.error ||= { code: runtime.stopReason === 'timed_out' ? 'DEADLINE_EXCEEDED' : 'WORKER_STOPPED', message: 'Partial changes are preserved. Inspect them before an explicit follow-up.' };
      job.finished_at = stamp();
      if (stopped) for (const lock of job.locks) await this.locker.release(lock, job.job_id);
      runtime.finished = true;
      job.state = finalState;
      await this.event(job, 'finished', { state: job.state, stop_reason: job.stop_reason, error: job.error });
      runtime.toolCalls.clear(); runtime.grants.clear(); runtime.requests.clear();
      if (stopped) this.jobs.delete(job.job_id);
    }
  }

  async updateLocks(job) {
    for (const lock of job.locks) await jsonFile(path.join(lock, 'owner.json'), { job_id: job.job_id, runner_pid: job.runner_pid, pid: job.pid,
      pids: job.active_terminals.map(item => item.pid).filter(Boolean) });
  }

  async update(job, params) {
    const runtime = job[internal];
    if (runtime.loading) return; // session/load replays history; do not misattribute it to this revision.
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const combined = job.summary + update.content.text;
      job.output_truncated ||= combined.length > TEXT_LIMIT;
      job.summary = combined.slice(-TEXT_LIMIT);
      await this.event(job, 'message', { text: update.content.text.slice(0, 4000), truncated: update.content.text.length > 4000 });
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const previous = runtime.toolCalls.get(update.toolCallId) || {};
      const merged = { toolCallId: update.toolCallId, kind: update.kind || previous.kind,
        title: String(update.title || previous.title || '').slice(0, 512), status: update.status || previous.status,
        locations: update.locations?.slice(0, 32) || previous.locations,
        rawInput: { command: (update.rawInput?.command || previous.rawInput?.command)?.slice(0, 8192) },
        _meta: { terminal_exit: update._meta?.terminal_exit || previous._meta?.terminal_exit } };
      if (runtime.toolCalls.size < 512 || runtime.toolCalls.has(update.toolCallId)) runtime.toolCalls.set(update.toolCallId, merged);
      else job.output_truncated = true;
      await this.event(job, 'tool', { tool_call_id: update.toolCallId, kind: merged.kind, title: merged.title,
        status: merged.status, locations: merged.locations?.slice(0, 32), command: merged.rawInput?.command,
        exit_status: merged._meta?.terminal_exit });
    }
  }

  async permission(job, params, { signal } = {}) {
    const tool = { ...job[internal].toolCalls.get(params.toolCall.toolCallId), ...params.toolCall };
    const command = params.toolCall._meta?.['cognition.ai/editableCommand'] ?? tool.rawInput?.command;
    const candidates = job.assignment.checks.filter(check => check.command === command && (!check.owner || check.owner === 'devin'));
    const check = job.assignment.profile === 'edit_check' && candidates.length === 1 ? candidates[0] : null;
    const allow = params.options.find(option => option.kind === 'allow_once');
    const deny = params.options.find(option => option.kind === 'reject_once');
    let approved = false;
    if (check && allow && check.approval === 'automatic') approved = true;
    else {
      const response = await this.attention(job, { kind: 'permission', command: command || null,
        check_id: check?.id || null, cwd: check?.cwd || null, tool_call_id: params.toolCall.toolCallId,
        approval_allowed: Boolean(check && allow), reason: check ? 'Declared check requires a one-time decision.' : 'Action is not an unambiguous declared check; amend the assignment or use its native executor.',
        native_handoff: { command: command || null, cwd: job.cwd, owner: 'native_executor' } }, signal);
      approved = response.decision === 'approve_once' && Boolean(check && allow);
    }
    if (approved && check.approval === 'ask') job[internal].grants.set(check.id, (job[internal].grants.get(check.id) || 0) + 1);
    if (!approved) await this.block(job, 'PERMISSION_DENIED', { command: command || null, tool_call_id: params.toolCall.toolCallId });
    return approved ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : deny ? { outcome: { outcome: 'selected', optionId: deny.optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  async authorizeCheck(job, check, params) {
    if (check.approval === 'automatic') return true;
    const available = job[internal].grants.get(check.id) || 0;
    if (available) { job[internal].grants.set(check.id, available - 1); return true; }
    const response = await this.attention(job, { kind: 'permission', approval_allowed: true,
      check_id: check.id, command: check.command, cwd: check.cwd, reason: 'Declared check requires a one-time decision at execution.' });
    if (response.decision !== 'approve_once') { await this.block(job, 'PERMISSION_DENIED', { command: params.command }); return false; }
    return true;
  }

  async elicitation(job, params, { signal } = {}) {
    if (params.mode !== 'form' || !params.requestedSchema || JSON.stringify(params.requestedSchema).length > 16384) {
      await this.block(job, 'INPUT_UNSUPPORTED', { message: 'Only bounded local form questions are supported.' });
      return { action: 'decline' };
    }
    const response = await this.attention(job, { kind: 'input', message: String(params.message || '').slice(0, 8192),
      schema: params.requestedSchema, allow_other: params._meta?.['cognition.ai/allowOther'] === true }, signal);
    return response.decision === 'answer' ? { action: 'accept', content: response.answers } : { action: 'cancel' };
  }

  async attention(job, request, signal) {
    const runtime = job[internal];
    if (runtime.stopReason || signal?.aborted || runtime.finalizing) return { decision: 'deny' };
    if (job.pending_requests.length >= 16) throw fault('ATTENTION_LIMIT', 'Too many pending worker requests.');
    const entry = { request_id: randomUUID(), ...request, created_at: stamp(), revision: job.revision };
    const answer = new Promise(resolve => { runtime.requests.set(entry.request_id, { entry, resolve }); });
    const abort = () => runtime.requests.get(entry.request_id)?.resolve({ decision: 'deny' });
    signal?.addEventListener('abort', abort, { once: true });
    job.pending_requests.push(entry);
    job.state = request.kind === 'input' ? 'needs_input' : 'needs_permission';
    await this.event(job, 'attention', entry);
    try { return await answer; }
    finally {
      signal?.removeEventListener('abort', abort);
      runtime.requests.delete(entry.request_id);
      job.pending_requests = job.pending_requests.filter(item => item.request_id !== entry.request_id);
      if (!runtime.finalizing) {
        job.state = job.pending_requests.some(item => item.kind === 'input') ? 'needs_input' : job.pending_requests.length ? 'needs_permission' : 'running';
        await this.event(job, 'attention_resolved', { request_id: entry.request_id });
      }
    }
  }

  async block(job, code, details) {
    if (job.blockers.length < 64) job.blockers.push({ code, ...bounded(details), at: stamp() });
    else job.output_truncated = true;
    await this.event(job, 'action_blocked', { code, ...bounded(details) });
  }

  async canonicalFile(job, value, writing) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fault('INVALID_FILE_PATH', 'ACP file paths must be absolute.');
    let target = path.resolve(value);
    try { target = await fs.realpath(target); }
    catch (error) {
      if (!writing || error.code !== 'ENOENT') throw error;
      let ancestor = path.dirname(target);
      const parts = [path.basename(target)];
      for (;;) {
        try { target = path.join(await fs.realpath(ancestor), ...parts); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; parts.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
      }
    }
    const relative = path.relative(job.workspace_root, target).split(path.sep).join('/');
    const attachment = job.attachments?.some(item => item.path === target);
    if ((!beneath(job.workspace_root, target) && (writing || !attachment)) ||
        (writing && (job.assignment.profile === 'read' || relative.split('/').includes('.git') || !matchesOwnedPath(relative, job.assignment)))) {
      await this.block(job, writing ? 'WRITE_OUT_OF_SCOPE' : 'READ_OUT_OF_SCOPE', { path: value });
      throw fault('FILE_OUT_OF_SCOPE', 'The requested file is outside this assignment’s allowed file access.');
    }
    return target;
  }

  async readText(job, params) {
    const target = await this.canonicalFile(job, params.path, false);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fault('FILE_READ_LIMIT', 'Text reads require a regular file of at most 2 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(handle, 2 * 1024 * 1024, 'FILE_READ_LIMIT'));
      const line = integer(params.line, 1, 1_000_000, 'line');
      const limit = params.limit == null ? undefined : integer(params.limit, undefined, 1_000_000, 'limit');
      return { content: params.line == null && limit === undefined ? text : text.split('\n').slice(Math.max(0, line - 1), limit === undefined ? undefined : Math.max(0, line - 1) + limit).join('\n') };
    } finally { await handle.close(); }
  }

  fileOperation(job, method, params, { signal } = {}) {
    const runtime = job[internal];
    if (runtime.stopReason || runtime.finalizing || signal?.aborted) throw fault('WORKER_STOPPED', 'File access stopped with this turn.');
    const operation = this[method](job, params, signal);
    runtime.fsOperations.add(operation);
    operation.finally(() => runtime.fsOperations.delete(operation)).catch(() => {});
    return operation;
  }

  async writeText(job, params, signal) {
    if (typeof params.content !== 'string' || Buffer.byteLength(params.content) > 2 * 1024 * 1024) throw fault('FILE_WRITE_LIMIT', 'Text writes are limited to 2 MiB.');
    const target = await this.canonicalFile(job, params.path, true);
    if (job[internal]?.stopReason || job[internal]?.finalizing || signal?.aborted) throw fault('WORKER_STOPPED', 'File editing stopped with this turn.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw fault('PATH_CHANGED', 'The destination directory changed while validating ownership.');
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o644);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fault('INVALID_FILE_TYPE', 'Only regular text files can be edited.');
      if (stat.nlink !== 1) throw fault('MULTILINK_WRITE_DENIED', 'The file has multiple hard links; scoped editing cannot establish ownership of every target.');
      if (job[internal]?.stopReason || job[internal]?.finalizing || signal?.aborted) throw fault('WORKER_STOPPED', 'File editing stopped with this turn.');
      await handle.truncate(0); await handle.writeFile(params.content, 'utf8');
    } finally { await handle.close(); }
    await this.event(job, 'file_written', { path: target, sha256: digest(params.content), bytes: Buffer.byteLength(params.content) });
    return {};
  }

  async checkEvidence(job, evidence) {
    const entry = job.checks.find(check => check.id === evidence.check_id);
    let source;
    try {
      const snapshot = await gitSnapshot(job.cwd);
      source = { head: snapshot.head, snapshot_sha256: digest(snapshotEvidence(snapshot)),
        complete: assessChanges(snapshot, snapshot, job.assignment).evidence.completeness === 'complete', observed_at: stamp() };
    } catch { source = { complete: false, snapshot_sha256: null }; }
    if (entry) Object.assign(entry, evidence, { evidence_source: 'bridge_terminal', status: evidence.type === 'terminal_started' ? 'running'
      : evidence.outcome === 'completed' && evidence.evidence_complete && evidence.exit_code === 0 ? 'passed'
        : evidence.outcome === 'failed' ? 'failed' : 'unknown' });
    if (entry) entry[evidence.type === 'terminal_started' ? 'source_before' : 'source_after'] = source;
    if (evidence.type === 'terminal_started') job.active_terminals.push(evidence);
    if (evidence.type === 'terminal_finished' && evidence.process_group_gone) job.active_terminals = job.active_terminals.filter(item => item.terminal_id !== evidence.terminal_id);
    job.output_truncated ||= evidence.output_truncated === true;
    await this.event(job, evidence.type || 'check', bounded(evidence));
    await this.updateLocks(job);
  }

  async event(job, type, data) {
    job.cursor++;
    job.events.push({ cursor: job.cursor, revision: job.revision, at: stamp(), type, data: bounded(data) });
    if (job.events.length > MAX_EVENTS) job.events.shift();
    await this.save(job);
  }

  save(job) {
    const data = JSON.parse(JSON.stringify(job)); // Symbol-keyed live process state is never persisted.
    const runtime = job[internal];
    if (!runtime) return jsonFile(job.artifacts.record || path.join(job.artifacts.directory, 'job.json'), data);
    const operation = runtime.save.catch(() => {}).then(() => jsonFile(job.artifacts.record, data));
    runtime.save = operation;
    return operation;
  }

  view(job, afterCursor = 0, deduplicated = false) {
    const { assignment, runner_pid, runner_identity, pid, process_identity, locks, events, active_terminals, ...result } = job;
    delete result[internal];
    result.state = job[internal]?.finalizing && !job[internal]?.finished ? 'finalizing' : job.state;
    const fresh = (events || []).filter(event => event.cursor > afterCursor);
    result.events = fresh.slice(0, 32);
    result.next_cursor = result.events.at(-1)?.cursor ?? Math.max(afterCursor, job.cursor || 0);
    result.events_remaining = fresh.length > result.events.length;
    result.cursor_gap = Boolean(events?.length && afterCursor < events[0].cursor - 1);
    result.task_accepted = false;
    result.outcome = outcomes(job, result.state);
    result.assignment = assignment ? { role: assignment.role, owned_paths: assignment.owned_paths, profile: assignment.profile,
      resources: assignment.resources, acceptance: assignment.acceptance } : undefined;
    result.capacity = this.describe();
    if (deduplicated) result.deduplicated = true;
    return result;
  }

  quietView(job, cursor, afterToken) {
    const state = job[internal]?.finalizing && !job[internal]?.finished ? 'finalizing' : job.state;
    const finished = terminal.has(state);
    const pending = job.pending_requests || [];
    // Text/tool progress must not invalidate the acknowledgment. Terminal
    // evidence changes (e.g. a later native check record) do invalidate it.
    const token = digest({ job_id: job.job_id, revision: job.revision, state, pending,
      report: finished ? { finished_at: job.finished_at, stop_reason: job.stop_reason, prompt_attempted: job.prompt_attempted,
        exit_code: job.exit_code, summary: job.summary, error: job.error,
        blockers: job.blockers, changed_files: job.changed_files, scope_status: job.scope_status, out_of_scope: job.out_of_scope,
        checks: reportChecks(job), source: job.source, evidence: job.evidence, output_truncated: job.output_truncated,
        preflight_ready: job.preflight?.ready,
        model: job.model, resolved_model: job.resolved_model, session_id: job.session_id, review: job.review } : null });
    const changed = token !== afterToken;
    const result = {
      mode: 'quiet', job_id: job.job_id, assignment_id: job.assignment_id, revision: job.revision,
      state, changed, next_token: token, resolved_model: job.resolved_model ?? null, session_id: job.session_id ?? null,
      wake_reason: changed && pending.length ? 'attention' : changed && finished ? 'terminal' : 'timeout',
      cursor: job.cursor || 0,
      // Quiet acknowledgment is separate from transcript consumption. Retain
      // the caller's diagnostic cursor and accurately report retention gaps.
      next_cursor: cursor,
      cursor_gap: Boolean(job.events?.length && cursor < job.events[0].cursor - 1),
      progress_events_suppressed: true,
      task_accepted: false,
      artifacts: { record: job.artifacts?.record || path.join(this.root, 'jobs', job.job_id, 'job.json') },
    };
    if (changed && pending.length) result.pending_requests = pending;
    if (changed && finished) { result.handoff = finalHandoff(job); result.outcome = outcomes(job, state); }
    return result;
  }

  async report({ job_id }) {
    const job = await this.load(job_id);
    const state = job[internal]?.finalizing && !job[internal]?.finished ? 'finalizing' : job.state;
    if (!terminal.has(state)) throw fault('JOB_ACTIVE', 'The final report is available after this turn finishes.');
    const compact = finalHandoff(job);
    const outcome = outcomes(job, state);
    const blockers = (job.blockers || []).slice(0, 16).map(item => ({ code: item.code, ...bounded(item, 2048) }));
    const checks = compact.checks.map(check => {
      const native = reportChecks(job).find(item => item.id === check.id)?.native_evidence;
      return { ...check, ...(native ? { native_evidence: { status: native.status, exit_code: native.exit_code,
        executor: native.executor, source_sha: native.source_sha, recorded_at: native.recorded_at,
        provenance: 'caller_reported_not_independently_executed' } } : {}) };
    });
    // job.json durably stores the retained answer and evidence independently of
    // the rolling event buffer. Project that current record rather than keeping
    // a second report file which could become stale after native check records.
    return { report_available: true, report_source: 'durable_job_record', job_id: job.job_id,
      assignment_id: job.assignment_id, revision: job.revision, job_state: state, legacy: job.schema_version !== 2,
      model: job.resolved_model ?? job.model, session_id: job.session_id,
      execution: outcome.execution, problem: compact.error,
      answer: { text: job.summary || '', output_truncated: Boolean(job.output_truncated) },
      evidence: { ...compact.evidence, ...outcome.evidence },
      verification: { ...outcome.verification, checks, check_count: compact.check_count,
        checks_truncated: checks.length < compact.check_count },
      policy: { ...outcome.policy, scope_status: job.scope_status, blockers,
        blocker_count: job.blockers?.length || 0, blockers_truncated: JSON.stringify(blockers) !== JSON.stringify(job.blockers || []),
        out_of_scope: job.out_of_scope?.slice(0, 16) ?? null, out_of_scope_count: job.out_of_scope?.length ?? null },
      acceptance: outcome.acceptance, task_accepted: false,
      changed_files: compact.changed_files, changed_file_count: compact.changed_file_count,
      details_truncated: compact.details_truncated || (job.blockers?.length || 0) > 16 || (job.out_of_scope?.length || 0) > 16,
      source: compact.source,
      ...(job.review ? { review: { base_sha: job.review.base_sha, head_sha: job.review.head_sha,
        complete: job.review.complete, packet_sha256: job.review.packet_sha256, comparison_id: job.review.comparison_id } } : {}),
      artifacts: { record: job.artifacts?.record || path.join(this.root, 'jobs', job.job_id, 'job.json'),
        before: job.artifacts?.before, after: job.artifacts?.after },
    };
  }

  async load(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw fault('INVALID_JOB_ID', 'Use a returned job_id.');
    if (this.jobs.has(id)) return this.jobs.get(id);
    let job;
    try { job = await readJson(path.join(this.root, 'jobs', id, 'job.json')); }
    catch (error) { if (error.code === 'ENOENT') throw fault('JOB_NOT_FOUND', 'No persisted job has this ID in this state directory.'); throw error; }
    if (!terminal.has(job.state) && !await this.ownerAlive(job)) {
      job.state = 'interrupted'; job.finished_at = stamp(); job.changed_files = null;
      job.pending_requests = []; job.workspace_evidence = 'incomplete_after_interruption';
      job.evidence = { completeness: 'incomplete', reasons: ['bridge_interrupted'], coverage: 'unknown_after_interruption' };
      job.scope_status = 'unknown'; job.out_of_scope = null;
      job.error = { code: 'BRIDGE_INTERRUPTED', message: 'The owner exited. Cancel to reconcile any surviving processes, inspect partial changes, then explicitly follow up. The prompt was not replayed.' };
      job.cursor = (job.cursor || 0) + 1;
      job.events ||= []; job.events.push({ cursor: job.cursor, at: stamp(), type: 'interrupted', data: job.error });
      await this.save(job);
    }
    return job;
  }

  async ownerAlive(job) {
    if (!alive(job.runner_pid)) return false;
    return !job.runner_identity || await processIdentity(job.runner_pid) === job.runner_identity;
  }

  checkWait(signal) {
    waitCancelled(signal);
    if (this.closed) throw fault('BRIDGE_CLOSED', 'The bridge is shutting down; discover the worker before waiting again.');
  }

  async wait(args, { signal } = {}) {
    const { job_id } = args;
    const { mode, cursor, seconds, token } = waitOptions(args);
    const until = Date.now() + seconds * 1000;
    do {
      this.checkWait(signal);
      const job = await this.load(job_id);
      this.checkWait(signal);
      if (mode === 'quiet') {
        const snapshot = this.quietView(job, cursor, token);
        if (snapshot.wake_reason !== 'timeout' || Date.now() >= until) return snapshot;
      } else if ((job.cursor || 0) > cursor || (terminal.has(job.state) && !job[internal]?.finalizing) || job[internal]?.finished || job.pending_requests?.length || Date.now() >= until) {
        return this.view(job, cursor);
      }
      await waitDelay(Math.min(200, until - Date.now()), signal);
    } while (true);
  }

  async waitMany({ jobs, wait_seconds = 10, mode = 'progress' }, { signal } = {}) {
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 32) throw fault('INVALID_WAIT', 'Wait on 1–32 jobs.');
    if (jobs.some(item => !item || typeof item !== 'object')) throw fault('INVALID_WAIT', 'Each wait target must identify a job.');
    if (new Set(jobs.map(item => item.job_id)).size !== jobs.length) throw fault('INVALID_WAIT', 'Wait targets must have distinct job IDs.');
    const { seconds } = waitOptions({ mode, wait_seconds });
    for (const item of jobs) waitOptions({ ...item, mode, wait_seconds: 0 });
    const until = Date.now() + seconds * 1000;
    do {
      this.checkWait(signal);
      const results = await Promise.all(jobs.map(item => this.wait({ ...item, mode, wait_seconds: 0 }, { signal }).catch(error => {
        if (error.code === 'WAIT_CANCELLED' || error.code === 'BRIDGE_CLOSED') throw error;
        return { job_id: item.job_id, state: 'error', error: { code: error.code, message: error.message } };
      })));
      this.checkWait(signal);
      const actionable = mode === 'quiet'
        ? results.find(result => result.state === 'error' || result.wake_reason !== 'timeout')
        : results.find((result, i) => result.state === 'error' || result.cursor > (jobs[i].after_cursor || 0) || terminal.has(result.state) || result.pending_requests?.length);
      if (actionable || Date.now() >= until) {
        return { jobs: results, ...(mode === 'quiet' ? { mode, wake_reason: actionable?.state === 'error' ? 'error' : actionable?.wake_reason || 'timeout' } : {}), capacity: this.describe() };
      }
      await waitDelay(Math.min(200, until - Date.now()), signal);
    } while (true);
  }

  async list({ assignment_id, limit = 20, cursor } = {}) {
    limit = integer(limit, 20, 100, 'limit');
    if (!limit) throw fault('INVALID_LIMIT', 'limit must be positive.');
    let entries;
    try { entries = (await fs.readdir(path.join(this.root, 'jobs'))).filter(id => /^[0-9a-f-]{36}$/.test(id)).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    if (cursor && !entries.includes(cursor)) throw fault('INVALID_CURSOR', 'Use next_cursor from a prior listing.');
    const results = [];
    let next = null;
    for (const id of entries.filter(id => !cursor || id > cursor)) {
      const job = await this.load(id);
      if (assignment_id && job.assignment_id !== assignment_id) continue;
      if (results.length === limit) { next = results.at(-1).job_id; break; }
      results.push({ job_id: id, assignment_id: job.assignment_id, revision: job.revision, previous_job_id: job.previous_job_id,
        state: this.view(job).state, cwd: job.cwd, model: job.model, resolved_model: job.resolved_model,
        cursor: job.cursor || 0, session_id: job.session_id, started_at: job.started_at,
        pending_requests: job.pending_requests || [], error: job.error, legacy: job.schema_version !== 2 });
    }
    return { jobs: results, next_cursor: next, capacity: this.describe() };
  }

  async message(args) {
    const previous = await this.load(args.job_id);
    if (previous.schema_version !== 2 || !previous.session_id) throw fault('RESUME_UNAVAILABLE', 'This job has no verified ACP session; it cannot be resumed.');
    if (!terminal.has(previous.state) || previous[internal]?.finalizing && !previous[internal]?.finished) throw fault('SESSION_BUSY', 'Wait for this turn to finish before sending a follow-up.');
    if (previous.state !== 'completed' && args.acknowledge_partial_work !== true) throw fault('PARTIAL_WORK_REVIEW_REQUIRED', 'Inspect this turn’s partial changes and explicitly acknowledge them before continuing the same session.');
    const assignment = { ...previous.assignment, task: args.task, revision: args.revision,
      base_sha: args.base_sha ?? previous.source?.after?.head ?? previous.assignment.base_sha,
      attachments: args.attachments ?? [],
      ...(args.owned_paths !== undefined ? { owned_paths: args.owned_paths } : {}),
      ...(args.checks !== undefined ? { checks: args.checks } : {}),
      ...(args.review !== undefined ? { review: args.review } : {}),
    };
    const operation = this.start(assignment, previous);
    this.starting.add(operation);
    operation.finally(() => this.starting.delete(operation)).catch(() => {});
    return operation;
  }

  validateAnswer(request, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || JSON.stringify(answers).length > 16384) throw fault('INVALID_ANSWER', 'Supply a bounded object of form answers.');
    const schema = request.schema;
    if (schema.type !== 'object' || !schema.properties) throw fault('INPUT_SCHEMA_UNSUPPORTED', 'This input schema cannot be safely answered by the bridge.');
    for (const key of schema.required || []) if (!(key in answers)) throw fault('INVALID_ANSWER', `Missing required answer ${key}.`);
    for (const [key, value] of Object.entries(answers)) {
      const field = schema.properties[key];
      if (!field || field.type !== 'string' || typeof value !== 'string') throw fault('INPUT_SCHEMA_UNSUPPORTED', 'Only declared string answer fields are supported.');
      const choices = field.enum || field.oneOf?.map(item => item.const);
      if (choices && !request.allow_other && !choices.includes(value)) throw fault('INVALID_ANSWER', 'Select an offered answer.');
    }
  }

  async respond(args) {
    const job = await this.load(args.job_id);
    const request = job.pending_requests?.find(item => item.request_id === args.request_id);
    const responseFile = path.join(job.artifacts.directory, `response-${args.request_id}.json`);
    if (!/^[0-9a-f-]{36}$/.test(args.request_id || '')) throw fault('INVALID_REQUEST_ID', 'Use a pending request ID.');
    const response = { decision: args.decision, answers: args.answers ?? null, note: args.note ?? null };
    try {
      const prior = await readJson(responseFile);
      if (stable(prior) !== stable(response)) throw fault('RESPONSE_CONFLICT', 'This request already has a different decision.');
      return this.view(job);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!request) throw fault('REQUEST_NOT_PENDING', 'This request is no longer pending.');
    if (args.decision === 'approve_once' && (request.kind !== 'permission' || !request.approval_allowed)) throw fault('ACTION_NOT_DECLARED', 'This action cannot be approved under the current assignment. Deny it and amend the assignment or use the native executor.');
    if (args.decision === 'answer') {
      if (request.kind !== 'input') throw fault('INVALID_RESPONSE', 'This request is not an input form.');
      this.validateAnswer(request, args.answers);
    } else if (!['approve_once', 'deny'].includes(args.decision)) throw fault('INVALID_RESPONSE', 'Choose approve_once, deny, or answer.');
    try { await fs.writeFile(responseFile, JSON.stringify(response), { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (stable(await readJson(responseFile)) !== stable(response)) throw fault('RESPONSE_CONFLICT', 'This request already has a different decision.');
    }
    if (job[internal]) job[internal].requests.get(args.request_id)?.resolve(response);
    await delay(0);
    return this.view(await this.load(args.job_id));
  }

  async controls(job) {
    const runtime = job[internal];
    if (runtime.controlsBusy || runtime.finalizing) return;
    runtime.controlsBusy = true;
    try {
      try { await fs.access(path.join(job.artifacts.directory, 'cancel.json')); void this.stop(job, 'cancelled'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const [id, request] of runtime.requests) {
        try { request.resolve(await readJson(path.join(job.artifacts.directory, `response-${id}.json`))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally { runtime.controlsBusy = false; }
  }

  async stop(job, reason) {
    const runtime = job[internal];
    if (runtime.finished) return this.view(job);
    if (runtime.stopping) { await runtime.stopping; return this.view(job); }
    runtime.stopReason ||= reason;
    runtime.stopping = (async () => {
      await this.event(job, 'termination_requested', { reason: runtime.stopReason });
      for (const request of runtime.requests.values()) request.resolve({ decision: 'deny' });
      if (job.session_id && runtime.client) await runtime.client.cancel(job.session_id);
      if (runtime.executor) await runtime.executor.close();
      if (runtime.client) await runtime.client.close();
    })();
    await runtime.stopping;
    if (runtime.done) await runtime.done;
    return this.view(job);
  }

  async cancel(id) {
    const job = await this.load(id);
    if (job[internal]?.finished) { this.jobs.delete(id); return this.cancel(id); }
    if (job[internal]) return this.stop(job, 'cancelled');
    if (await this.ownerAlive(job) && !terminal.has(job.state)) {
      await jsonFile(path.join(job.artifacts.directory, 'cancel.json'), { at: stamp() });
      return { ...this.view(job), termination_requested: 'cancelled' };
    }
    if (job.schema_version !== 2) return this.locker.cancel(id);
    const processes = [...(job.active_terminals || []), { pid: job.pid, process_identity: job.process_identity }];
    for (const entry of processes) {
      if (!entry.pid || !alive(-entry.pid)) continue;
      const observed = await processIdentity(entry.pid);
      const expected = entry.process_identity;
      const matches = typeof expected === 'string' ? observed === expected
        : expected?.marker && expected.group_pid === entry.pid && observed?.includes(expected.marker);
      if (!matches) throw fault('PROCESS_IDENTITY_UNVERIFIED', 'A surviving process cannot be safely identified. Its locks are retained for manual inspection.');
      await signalGroup(entry.pid, 'SIGTERM');
      if (!await groupGone(entry.pid, 3000)) { await signalGroup(entry.pid, 'SIGKILL'); await groupGone(entry.pid, 1000); }
      if (alive(-entry.pid)) throw fault('CANCELLATION_PENDING', 'A worker process group remains. Its locks are retained.');
    }
    if (!terminal.has(job.state) || job.state === 'interrupted') {
      job.state = 'cancelled'; job.finished_at = stamp(); job.changed_files = null;
      job.evidence = { completeness: 'incomplete', reasons: ['owner_interrupted'], coverage: 'unknown_after_interruption' };
      job.error = { code: 'RECOVERED_CANCELLATION', message: 'Surviving owned processes were stopped. Inspect partial changes before follow-up.' };
      await this.event(job, 'cancelled', job.error);
    }
    for (const lock of job.locks || []) await this.locker.release(lock, id);
    return this.view(job);
  }

  async recordCheck(args) {
    // Native executors may report different checks concurrently. Serialize the
    // complete read/modify/write so neither report overwrites the other one.
    await this.load(args.job_id);
    const lock = path.join(this.root, 'record-locks', args.job_id);
    await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    let held = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await this.locker.acquire(lock, args.job_id); held = true; break; }
      catch (error) { if (error.code !== 'WORKSPACE_BUSY') throw error; await delay(100); }
    }
    if (!held) throw fault('RECORD_BUSY', 'Another executor is updating this job’s evidence. Retry the same report.');
    try { return await this.recordCheckLocked(args); }
    finally { await this.locker.release(lock, args.job_id); }
  }

  async recordCheckLocked(args) {
    const job = await this.load(args.job_id);
    if (!terminal.has(job.state) || job[internal]?.finalizing && !job[internal]?.finished) throw fault('JOB_ACTIVE', 'Record native evidence after the turn finishes.');
    const check = job.checks?.find(item => item.id === args.check_id);
    if (!check || args.command !== check.command) throw fault('CHECK_MISMATCH', 'Reference the declared check and its exact command.');
    if (typeof args.executor !== 'string' || !args.executor.trim()) throw fault('EXECUTOR_REQUIRED', 'Name the native executor supplying evidence.');
    if (check.owner && check.owner !== 'devin' && check.owner !== args.executor) throw fault('EXECUTOR_MISMATCH', 'The evidence executor must match this check’s declared owner.');
    if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || await fs.realpath(args.cwd) !== check.cwd)) throw fault('CHECK_CWD_MISMATCH', 'Evidence must identify the declared check directory.');
    const sourceSha = job.source?.after?.head ?? null;
    if (args.source_sha !== undefined && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(args.source_sha) || !sourceSha || args.source_sha.toLowerCase() !== sourceSha)) throw fault('CHECK_SOURCE_MISMATCH', 'Evidence must refer to the recorded source HEAD after this turn.');
    if (!['passed', 'failed', 'blocked'].includes(args.status) || args.status === 'passed' && args.exit_code !== 0) throw fault('INVALID_CHECK_EVIDENCE', 'A passed check requires an explicit zero exit code.');
    const artifacts = [];
    if (!Array.isArray(args.artifact_paths || []) || (args.artifact_paths || []).length > 16) throw fault('ARTIFACT_LIMIT', 'Attach at most 16 local check artifacts.');
    for (const file of args.artifact_paths || []) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw fault('INVALID_ARTIFACT', 'Artifact paths must be absolute local files.');
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw fault('ARTIFACT_LIMIT', 'Each evidence artifact must be a regular file of at most 8 MiB.');
        const data = await readBounded(handle, 8 * 1024 * 1024, 'ARTIFACT_LIMIT');
        artifacts.push({ path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      } finally { await handle.close(); }
    }
    check.native_evidence = { status: args.status, command: args.command, exit_code: args.exit_code ?? null,
      cwd: check.cwd, source_sha: args.source_sha?.toLowerCase() ?? null, expected_source_sha: sourceSha,
      executor: args.executor, artifacts, recorded_at: stamp(), provenance: 'caller_reported_not_independently_executed' };
    await this.event(job, 'native_check_recorded', { check_id: check.id, ...check.native_evidence });
    return this.view(job);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.starting]);
    const results = await Promise.allSettled([...this.jobs.values()].filter(job => !job[internal].finished).map(job => this.stop(job, 'interrupted')));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
