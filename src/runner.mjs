import { spawn, execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { promises as fs, constants, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createRestrictedGitReadPolicy } from './git-read-policy.mjs';

const exec = promisify(execFile);
const BUNDLED_CLI = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled', 'timed_out', 'interrupted']);
const LOG_LIMIT = 8 * 1024 * 1024;
const TAIL_LIMIT = 16000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fault(code, message, state = 'blocked') {
  return Object.assign(new Error(message), { code, state, retryable: false });
}

export async function jsonFile(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export async function signalGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    // Darwin can report EPERM while an exiting group contains only zombies.
    // Ignore it only after the group is confirmed gone; retain genuine errors.
    if (process.platform === 'darwin' && error.code === 'EPERM' && await groupGone(pid, 1000)) return;
    throw error;
  }
}
export async function groupGone(pid, milliseconds) {
  const until = Date.now() + milliseconds;
  while (alive(-pid) && Date.now() < until) await delay(50);
  return !alive(-pid);
}
async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function resolveDevinPath() {
  const override = process.env.DEVIN_CLI_PATH;
  const candidates = override ? [override] : [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, 'devin')),
    BUNDLED_CLI,
  ];
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      await fs.access(resolved, constants.X_OK);
      return resolved;
    } catch { /* Try the next installed location. */ }
  }
  throw fault('CLI_NOT_FOUND', override ? `DEVIN_CLI_PATH is not an executable: ${override}` : 'Install Devin CLI or set DEVIN_CLI_PATH.');
}

export function childEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, TERM: 'dumb', NO_COLOR: '1' };
}

export async function repositoryRoot(cwd) {
  try {
    const root = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10000, env: childEnvironment() })).stdout.trim();
    return await fs.realpath(root);
  } catch (error) {
    if (error.code === 128 && /not a git repository/i.test(error.stderr || '')) return null;
    throw fault('GIT_INSPECTION_FAILED', `Cannot inspect workspace: ${error.message}`);
  }
}

export async function gitSnapshot(cwd, { review = false } = {}) {
  const policy = review ? await createRestrictedGitReadPolicy(cwd, { environment: childEnvironment() }) : null;
  const options = { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: policy?.env ?? childEnvironment() };
  const git = async args => {
    const result = await exec('git', [...(policy?.prefix ?? []), ...args], { ...options, ...(review ? { encoding: 'buffer' } : {}) });
    if (review) {
      try { result.stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout); }
      catch { throw fault('GIT_INSPECTION_FAILED', 'Restricted Git snapshot output is not valid UTF-8; no partial evidence was accepted.'); }
    }
    return result;
  };
  let root;
  if (review) {
    try { root = await fs.realpath((await git(['rev-parse', '--show-toplevel'])).stdout.replace(/\r?\n$/, '')); }
    catch (error) {
      if (error.code === 128 && /not a git repository/i.test(String(error.stderr || ''))) root = null;
      else throw error;
    }
  } else root = await repositoryRoot(cwd);
  if (!root) return { repository: null, files: {}, head: null, index: {}, tree: {}, status: '', diff: '', staged_diff: '',
    ...(review ? { complete: false, coverage: 'unavailable_non_git', limitations: ['No Git repository was available for a restricted review snapshot.'] } : {}) };
  options.cwd = root;
  const submodules = review ? ['--ignore-submodules=all'] : [];
  const [status, diff, staged, indexResult, headResult] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...submodules]),
    git(['diff', '--no-ext-diff', '--no-textconv', ...submodules]),
    git(['diff', '--cached', '--no-ext-diff', '--no-textconv', ...submodules]),
    git(['ls-files', '--stage', '-z', '--full-name']),
    git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch((error) => {
      if (error.code === 1) return { stdout: '' }; // An unborn branch has no HEAD.
      throw error;
    }),
  ]);
  const head = headResult.stdout.trim() || null;
  const treeResult = head ? await git(['ls-tree', '-r', '-z', head]) : { stdout: '' };
  const parseEntries = (output) => {
    const entries = Object.create(null);
    for (const record of output.split('\0').filter(Boolean)) {
      const separator = record.indexOf('\t');
      if (separator < 0) throw fault('GIT_INSPECTION_FAILED', 'Malformed Git snapshot entry.');
      const name = record.slice(separator + 1);
      entries[name] = `${entries[name] || ''}${record.slice(0, separator)}\n`;
    }
    return entries;
  };
  const index = parseEntries(indexResult.stdout);
  const tree = parseEntries(treeResult.stdout);
  const records = status.stdout.split('\0').filter(Boolean);
  if (records.length > 5000) throw fault('WORKSPACE_TOO_LARGE', 'More than 5,000 changed paths; use a smaller workspace for this POC.');
  const files = Object.create(null);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const name = record.slice(3);
    let fingerprint = 'missing';
    try {
      const target = path.join(root, name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) fingerprint = `link:${await fs.readlink(target)}`;
      else if (stat.isFile() && stat.size <= 4 * 1024 * 1024) fingerprint = createHash('sha256').update(await fs.readFile(target)).digest('hex');
      else fingerprint = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) { if (error.code !== 'ENOENT') fingerprint = `unreadable:${error.code}`; }
    files[name] = `${record.slice(0, 2)}:${fingerprint}`;
    if (/[RC]/.test(record.slice(0, 2))) {
      const previous = records[++i];
      if (previous) files[previous] = `renamed-to:${name}`;
    }
  }
  const snapshot = { repository: root, files, head, index, tree, status: status.stdout, diff: diff.stdout, staged_diff: staged.stdout };
  if (review) {
    const gitlinks = new Set([index, tree].flatMap(entries => Object.entries(entries).filter(([, value]) => /^160000 /m.test(value)).map(([name]) => name)));
    snapshot.complete = !policy.conversion_filters_disabled && gitlinks.size === 0;
    snapshot.coverage = 'git_visible_worktree_index_and_head_ignored_files_and_submodule_interiors_excluded';
    snapshot.limitations = [
      'Ignored files, external paths, and transient changes reverted before inspection are not fully observed.',
      ...(policy.conversion_filters_disabled ? ['Configured conversion filters were disabled; equivalence to ordinary filtered Git status/diffs is unknown.'] : []),
      ...(gitlinks.size ? ['Submodule interiors and worktree commit changes were excluded to avoid invoking nested Git helpers; index and HEAD gitlink entries remain recorded.'] : []),
    ];
    snapshot.restricted_git = { conversion_filters_disabled: policy.conversion_filters_disabled,
      function_drivers_disabled: policy.function_drivers_disabled, submodule_paths: [...gitlinks].sort(),
      global_git_config_disabled: true, external_helpers_disabled: true, lazy_fetch_disabled: true, replacement_refs_disabled: true };
  }
  return snapshot;
}

export function snapshotEvidence(snapshot) {
  return { repository: snapshot.repository, files: snapshot.files, head: snapshot.head, index: snapshot.index, tree: snapshot.tree,
    ...(Object.hasOwn(snapshot, 'complete') ? { complete: snapshot.complete } : {}),
    ...(Object.hasOwn(snapshot, 'coverage') ? { coverage: snapshot.coverage } : {}),
    ...(Object.hasOwn(snapshot, 'limitations') ? { limitations: snapshot.limitations } : {}),
    ...(Object.hasOwn(snapshot, 'restricted_git') ? { restricted_git: snapshot.restricted_git } : {}),
  };
}

async function exportResult(file) {
  const stat = await fs.stat(file);
  if (stat.size > 16 * 1024 * 1024) throw new Error('Conversation export exceeds the POC parsing limit; inspect the artifact.');
  const data = await readJson(file);
  if (!data || !/^ATIF-v1\./.test(data.schema_version || '') || typeof data.session_id !== 'string' || !data.session_id || !Array.isArray(data.steps)) {
    throw new Error('Expected a recognizable ATIF-v1 conversation export with a session identifier.');
  }
  const steps = data.steps;
  const final = steps.at(-1);
  if (!final || final.source !== 'agent' || typeof final.message !== 'string' || !final.message.trim() ||
      (final.tool_calls != null && (!Array.isArray(final.tool_calls) || final.tool_calls.length))) {
    throw new Error('Conversation export has no terminal agent answer.');
  }
  return {
    session_id: data.session_id ?? null,
    resolved_model: final?.model_name ?? [...steps].reverse().find((step) => step.source === 'agent' && step.model_name)?.model_name ?? data.agent?.model_name ?? null,
    summary: final?.message?.slice(-TAIL_LIMIT) ?? null,
    export_schema: data.schema_version ?? null,
  };
}

function classifyFailure(text) {
  if (/not logged in|please (log|sign) in|authentication.*(fail|required)|unauthenticated/i.test(text)) return ['AUTH_REQUIRED', 'Authenticate with devin auth login.'];
  if (/untrusted|workspace trust|trust.*director/i.test(text)) return ['WORKSPACE_UNTRUSTED', 'Trust this workspace in Devin before starting an unattended task.'];
  if (/quota|usage limit|upgrade.*(plan|pro)|subscription|insufficient.*credit|not.*available.*(plan|account)/i.test(text)) return ['MODEL_ACCESS_BLOCKED', 'Devin rejected the requested model or account access. Inspect stderr for details.'];
  if (/approval required|permission required|requires confirmation|cannot.*prompt|non.interactive.*(permission|approval)|permission.*denied/i.test(text)) return ['PERMISSION_REQUIRED', 'The requested action needs a Devin permission that cannot be granted through this headless run.'];
  return null;
}

export class JobManager {
  constructor() {
    this.root = path.resolve(process.env.DEVIN_BRIDGE_STATE_DIR || path.join(os.homedir(), '.local/share/devin-bridge'));
    this.defaultModel = process.env.DEVIN_BRIDGE_MODEL || 'swe-2-medium';
    this.permissionMode = process.env.DEVIN_BRIDGE_PERMISSION_MODE || 'accept-edits';
    this.respectTrust = process.env.DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST !== 'false';
    this.jobs = new Map();
    this.active = null;
    this.starting = false;
    this.closed = false;
    this.startOperation = null;
  }

  describe() {
    return { default_model: this.defaultModel, permission_mode: this.permissionMode, respect_workspace_trust: this.respectTrust, state_directory: this.root };
  }

  run(args) {
    if (this.closed) return Promise.reject(fault('BRIDGE_CLOSED', 'The bridge is shutting down.'));
    if (this.starting || this.active) return Promise.reject(fault('WORKER_BUSY', 'This bridge already has a running or unreconciled job. Wait or cancel it.'));
    this.starting = true;
    this.startOperation = this.start(args).finally(() => { this.starting = false; this.startOperation = null; });
    return this.startOperation;
  }

  async start(args) {
    if (process.platform === 'win32') throw fault('PLATFORM_UNSUPPORTED', 'This POC supports POSIX process groups (macOS/Linux).');
    if (!args || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 65536) throw fault('INVALID_TASK', 'Supply a task of 1–65,536 characters.');
    if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) throw fault('INVALID_CWD', 'cwd must be an absolute directory path.');
    let cwd;
    try { cwd = await fs.realpath(args.cwd); if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); }
    catch { throw fault('INVALID_CWD', 'The working directory does not exist or cannot be accessed.'); }
    const model = args.model || this.defaultModel;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(model)) throw fault('INVALID_MODEL', 'Supply a Devin model identifier or alias.');
    const timeout = args.timeout_seconds ?? 900;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw fault('INVALID_TIMEOUT', 'timeout_seconds must be from 1 to 3600.');
    if (!['auto', 'normal', 'accept-edits', 'smart', 'dangerous', 'bypass'].includes(this.permissionMode)) throw fault('INVALID_PERMISSION_MODE', 'DEVIN_BRIDGE_PERMISSION_MODE is not a supported CLI permission mode.');
    const executable = await resolveDevinPath();
    const version = (await exec(executable, ['--version'], { env: childEnvironment(), timeout: 10000 })).stdout.trim();
    const repository = await repositoryRoot(cwd);
    const lockKey = createHash('sha256').update(repository || cwd).digest('hex');
    const id = randomUUID();
    const directory = path.join(this.root, 'jobs', id);
    const lock = path.join(this.root, 'locks', lockKey);
    await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    await this.acquire(lock, id);
    let job;
    try {
      const baseline = await gitSnapshot(cwd);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const promptPath = path.join(directory, 'prompt.txt');
      const exportPath = path.join(directory, 'conversation.json');
      const scope = args.scope ? `\nAssigned scope and constraints:\n${args.scope}\n` : '';
      await fs.writeFile(promptPath, `${args.task.trim()}\n${scope}\nWhen finished, report the result, files changed, and verification actually performed. Clearly report any blocked or unfinished work.\n`, { mode: 0o600 });
      await Promise.all([
        fs.writeFile(path.join(directory, 'before.diff'), baseline.diff, { mode: 0o600 }),
        fs.writeFile(path.join(directory, 'before-staged.diff'), baseline.staged_diff, { mode: 0o600 }),
        jsonFile(path.join(directory, 'before.json'), snapshotEvidence(baseline)),
      ]);
      job = {
        job_id: id, state: 'running', cwd, model, resolved_model: null, session_id: null,
        cli_path: executable, cli_version: version, permission_mode: this.permissionMode,
        respect_workspace_trust: this.respectTrust, scope: args.scope || null,
        timeout_seconds: timeout, started_at: new Date().toISOString(), finished_at: null,
        runner_pid: process.pid, pid: null, exit_code: null, signal: null,
        summary: null, error: null, changed_files: baseline.repository ? [] : null,
        git: baseline.repository ? { head_before: baseline.head, head_after: null, head_changed: null } : null,
        workspace_evidence: baseline.repository ? 'git_snapshot' : 'unavailable_non_git', baseline, lock,
        artifacts: { directory, prompt: promptPath, conversation: exportPath,
          stdout: path.join(directory, 'stdout.log'), stderr: path.join(directory, 'stderr.log'),
          before: path.join(directory, 'before.json'), after: path.join(directory, 'after.json'),
          before_diff: path.join(directory, 'before.diff'), after_diff: path.join(directory, 'after.diff') },
        stdoutTail: '', stderrTail: '', output_truncated: false, stopReason: null, finalized: false,
      };
      job.done = new Promise((resolve) => { job.resolveDone = resolve; });
      job.saveQueue = Promise.resolve();
      this.jobs.set(id, job);
      this.active = job;
      await this.save(job);
      if (this.closed) throw fault('BRIDGE_CLOSED', 'The bridge shut down before the worker started.');
      const cliArgs = ['--model', model, '--permission-mode', this.permissionMode,
        '--respect-workspace-trust', String(this.respectTrust), '--prompt-file', promptPath, '--export', exportPath, '--print'];
      const child = spawn(executable, cliArgs, { cwd, env: childEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      job.pid = child.pid ?? null;
      this.capture(job, child.stdout, 'stdout');
      this.capture(job, child.stderr, 'stderr');
      child.once('error', (error) => { job.spawnError = error.message; });
      child.once('close', (code, signal) => {
        job.exit_code = code; job.signal = signal;
        job.finishing = this.finish(job).catch(async (error) => {
          job.state = 'interrupted'; job.error = { code: 'FINALIZATION_FAILED', message: error.message };
          job.changed_files = null; job.workspace_evidence = 'incomplete_finalization';
          job.finished_at = new Date().toISOString();
          await this.save(job).catch(() => {});
        }).finally(() => { job.finalized = true; job.resolveDone(); });
      });
      await jsonFile(path.join(lock, 'owner.json'), { job_id: id, runner_pid: process.pid, pid: job.pid });
      await this.save(job);
      job.timer = setTimeout(() => { void this.stop(job, 'timed_out').catch((error) => {
        process.stderr.write(`Worker deadline cleanup failed: ${error.message}\n`);
      }); }, timeout * 1000);
      job.timer.unref();
      return this.view(job);
    } catch (error) {
      if (job?.child) { await this.stop(job, 'interrupted').catch(() => {}); }
      else {
        if (job) {
          job.state = 'failed'; job.error = { code: error.code || 'START_FAILED', message: error.message };
          job.finished_at = new Date().toISOString(); job.finalized = true; job.resolveDone();
          await this.save(job).catch(() => {});
        }
        this.active = null;
        await this.release(lock, id);
      }
      throw error;
    }
  }

  async acquire(lock, id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await jsonFile(path.join(lock, 'owner.json'), { job_id: id, runner_pid: process.pid, pid: null });
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const recovery = `${lock}.recovery`;
        try { await fs.mkdir(recovery, { mode: 0o700 }); }
        catch (recoveryError) {
          if (recoveryError.code === 'EEXIST') throw fault('WORKSPACE_BUSY', 'Another bridge is reconciling this checkout lock.');
          throw recoveryError;
        }
        try {
          // Read ownership inside the recovery guard; never act on a pre-guard snapshot.
          let owner;
          try { owner = await readJson(path.join(lock, 'owner.json')); }
          catch { throw fault('WORKSPACE_BUSY', 'Another bridge is acquiring this checkout, or its lock needs inspection.'); }
          let ownedTerminals = [];
          if (/^[0-9a-f-]{36}$/.test(owner.job_id || '')) {
            try { ownedTerminals = (await readJson(path.join(this.root, 'jobs', owner.job_id, 'job.json'))).active_terminals || []; }
            catch (error) { if (error.code !== 'ENOENT') throw fault('WORKSPACE_BUSY', 'Cannot verify the previous worker’s command ownership; its lock is retained.'); }
          }
          if (alive(owner.runner_pid) || (owner.pid && alive(-owner.pid)) ||
              (owner.pids || []).some(pid => alive(-pid)) || ownedTerminals.some(item => item.pid && alive(-item.pid))) {
            throw fault('WORKSPACE_BUSY', `Checkout held by job ${owner.job_id}. Wait for or cancel that job before writing here.`);
          }
          await fs.rm(lock, { recursive: true });
        } finally { await fs.rmdir(recovery); }
      }
    }
    throw fault('WORKSPACE_BUSY', 'Another bridge acquired this checkout during recovery.');
  }

  async release(lock, id) {
    try {
      const owner = await readJson(path.join(lock, 'owner.json'));
      if (owner.job_id === id) await fs.rm(lock, { recursive: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  capture(job, stream, name) {
    const fd = openSync(job.artifacts[name], 'w', 0o600);
    const decoder = new StringDecoder('utf8');
    let written = 0;
    stream.on('data', (chunk) => {
      const available = Math.max(0, LOG_LIMIT - written);
      if (available) written += writeSync(fd, chunk.subarray(0, available));
      if (chunk.length > available) job.output_truncated = true;
      job[`${name}Tail`] = (job[`${name}Tail`] + decoder.write(chunk)).slice(-TAIL_LIMIT);
    });
    stream.once('end', () => { job[`${name}Tail`] += decoder.end(); });
    stream.once('close', () => closeSync(fd));
  }

  view(job, persist = false) {
    const keys = ['job_id', 'state', 'cwd', 'model', 'resolved_model', 'session_id', 'cli_path', 'cli_version',
      'permission_mode', 'respect_workspace_trust', 'scope', 'timeout_seconds', 'started_at', 'finished_at',
      'runner_pid', 'pid', 'exit_code', 'signal', 'summary', 'error', 'changed_files', 'git', 'workspace_evidence', 'output_truncated', 'artifacts'];
    const value = Object.fromEntries(keys.map((key) => [key, job[key] ?? null]));
    if (!persist && job.done && !job.finalized && TERMINAL.has(job.state)) value.state = 'finalizing';
    value.task_accepted = false;
    if (job.stopReason && !TERMINAL.has(job.state)) value.termination_requested = job.stopReason;
    return value;
  }

  save(job) {
    const value = this.view(job, true);
    job.saveQueue = job.saveQueue.catch(() => {}).then(() => jsonFile(path.join(job.artifacts.directory, 'job.json'), value));
    return job.saveQueue;
  }

  async finish(job) {
    clearTimeout(job.timer);
    if (job.pid && alive(-job.pid)) {
      await signalGroup(job.pid, 'SIGTERM');
      if (!await groupGone(job.pid, 1000)) { await signalGroup(job.pid, 'SIGKILL'); await groupGone(job.pid, 1000); }
    }
    const groupRemaining = job.pid && alive(-job.pid);
    job.state = groupRemaining ? 'interrupted' : job.stopReason || (job.exit_code === 0 ? 'completed' : 'failed');
    if (groupRemaining) job.error = { code: 'PROCESS_GROUP_REMAINS', message: 'An owned process remains; the checkout lock is retained.' };
    const output = stripVTControlCharacters(`${job.stderrTail}\n${job.stdoutTail}`);
    if (!job.stopReason && !groupRemaining && job.exit_code !== 0) {
      const blocked = classifyFailure(output);
      if (blocked) { job.state = 'blocked'; job.error = { code: blocked[0], message: blocked[1] }; }
      else if (job.state === 'failed') job.error = { code: 'CLI_EXIT_FAILED', message: job.spawnError || output.slice(-4000) || `Devin exited with status ${job.exit_code}.` };
    }
    try { Object.assign(job, await exportResult(job.artifacts.conversation)); }
    catch (error) {
      job.export_error = error.message;
      if (job.state === 'completed') {
        // Devin can exit zero after declining a headless permission prompt.
        // Only inspect diagnostics here after the export failed verification.
        const blocked = classifyFailure(stripVTControlCharacters(job.stderrTail));
        job.state = blocked ? 'blocked' : 'interrupted';
        job.error = blocked ? { code: blocked[0], message: blocked[1] }
          : { code: 'RESULT_UNVERIFIED', message: `Process exited successfully but its export could not be verified: ${error.message}` };
      }
    }
    job.summary ||= stripVTControlCharacters(job.stdoutTail).trim().slice(-TAIL_LIMIT) || null;
    if (job.stopReason) job.error ||= { code: job.stopReason === 'timed_out' ? 'DEADLINE_EXCEEDED' : 'WORKER_STOPPED', message: 'Execution stopped. Any changes already made are preserved.' };
    try {
      const after = await gitSnapshot(job.cwd);
      if (job.baseline.repository && after.repository) {
        const layers = ['files', 'index', 'tree'];
        const names = new Set(layers.flatMap((layer) => [...Object.keys(job.baseline[layer]), ...Object.keys(after[layer])]));
        job.changed_files = [...names].filter((name) => layers.some((layer) => job.baseline[layer][name] !== after[layer][name])).sort();
        job.git = { head_before: job.baseline.head, head_after: after.head, head_changed: job.baseline.head !== after.head };
      } else { job.changed_files = null; job.git = null; }
      await Promise.all([
        jsonFile(job.artifacts.after, snapshotEvidence(after)),
        fs.writeFile(job.artifacts.after_diff, after.diff, { mode: 0o600 }),
        fs.writeFile(path.join(job.artifacts.directory, 'after-staged.diff'), after.staged_diff, { mode: 0o600 }),
      ]);
    } catch (error) {
      job.changed_files = null; job.workspace_evidence = 'incomplete_git_snapshot';
      job.error ||= { code: 'WORKSPACE_EVIDENCE_INCOMPLETE', message: error.message };
      if (job.state === 'completed') job.state = 'interrupted';
    }
    job.finished_at = new Date().toISOString();
    await this.save(job);
    if (!groupRemaining) {
      await this.release(job.lock, job.job_id);
      if (this.active === job) this.active = null;
    }
  }

  async load(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fault('INVALID_JOB_ID', 'Use the job_id returned by devin_run.');
    if (this.jobs.has(id)) return this.jobs.get(id);
    let record;
    try { record = await readJson(path.join(this.root, 'jobs', id, 'job.json')); }
    catch { throw fault('JOB_NOT_FOUND', 'No job record exists for this identifier in this bridge state directory.'); }
    if (!TERMINAL.has(record.state) && !alive(record.runner_pid)) {
      record.state = 'interrupted';
      record.changed_files = null;
      record.workspace_evidence = 'incomplete_after_interruption';
      record.error = { code: 'BRIDGE_INTERRUPTED', message: record.pid && alive(-record.pid) ? 'The previous bridge exited and its worker may still be running. Cancel this job to reconcile it.' : 'The previous bridge exited. Inspect the artifacts and workspace before starting another task.' };
      record.finished_at = new Date().toISOString();
      await jsonFile(path.join(record.artifacts.directory, 'job.json'), record);
    }
    return record;
  }

  async wait(id, seconds = 10) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw fault('INVALID_WAIT', 'wait_seconds must be from 0 to 30.');
    const job = await this.load(id);
    if (job.done && !job.finalized && seconds) await within(job.done, seconds * 1000);
    return job.done ? this.view(job) : await this.load(id);
  }

  async stop(job, reason) {
    if (job.finalized && !(job.pid && alive(-job.pid))) return this.view(job);
    if (job.finishing) {
      await within(job.done, 10000);
      return this.view(job);
    }
    if (job.stopPromise) return job.stopPromise;
    job.stopReason = reason;
    job.stopPromise = (async () => {
      await this.save(job);
      await signalGroup(job.pid, 'SIGTERM');
      if (!await within(job.done, 3000)) {
        await signalGroup(job.pid, 'SIGKILL');
        if (!await within(job.done, 5000)) throw fault('CANCELLATION_PENDING', 'Worker termination has not been confirmed; its lock remains held.');
      }
      return this.view(job);
    })().catch((error) => { job.stopPromise = null; throw error; });
    return job.stopPromise;
  }

  async cancel(id) {
    const job = await this.load(id);
    if (job.done) return this.stop(job, 'cancelled');
    if (job.pid && alive(-job.pid)) {
      if (alive(job.runner_pid)) throw fault('JOB_OWNED_BY_ANOTHER_BRIDGE', 'Cancel this job through the bridge that started it.');
      let command = '';
      try { command = (await exec('ps', ['-p', String(job.pid), '-o', 'command='], { timeout: 3000 })).stdout; } catch { /* Leave uncertain descendants untouched. */ }
      if (!command.includes(job.artifacts.prompt)) throw fault('PROCESS_IDENTITY_UNVERIFIED', 'Cannot establish ownership of the surviving process group. Inspect the recorded process before manual cleanup.');
      await signalGroup(job.pid, 'SIGTERM');
      if (!await groupGone(job.pid, 3000)) { await signalGroup(job.pid, 'SIGKILL'); await groupGone(job.pid, 1000); }
      if (alive(-job.pid)) throw fault('CANCELLATION_PENDING', 'The worker process group is still present.');
      job.state = 'cancelled'; job.finished_at = new Date().toISOString();
      job.error = { code: 'RECOVERED_CANCELLATION', message: 'Stopped the worker left by an interrupted bridge. Inspect its partial changes.' };
      await jsonFile(path.join(job.artifacts.directory, 'job.json'), job);
    }
    return job;
  }

  async close() {
    this.closed = true;
    if (this.startOperation) await this.startOperation.catch(() => {});
    if (this.active) await this.stop(this.active, 'interrupted');
  }
}
