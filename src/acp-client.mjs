import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SWE_MODELS = new Set(['swe-2-medium', 'swe-2-high', 'swe-2-max']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_PENDING_UPDATES = 512;
const MAX_QUEUED_UPDATE_BYTES = 16 * 1024 * 1024;
const MAX_THOUGHT_TOOLS = 4096;
const TERMINAL_METHODS = ['terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill'];
const FS_METHODS = ['fs/read_text_file', 'fs/write_text_file'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class AcpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function childEnvironment() {
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
  );
  // In particular, do not inherit DEVIN_MODEL or DEVIN_REFUSAL_FALLBACK.
  return { ...env, TERM: 'dumb', NO_COLOR: '1' };
}

function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function selectedModel(metadata) {
  return metadata?.configOptions?.find(option => option.category === 'model' || option.id === 'model')?.currentValue
    ?? metadata?.models?.currentModelId;
}

/**
 * Bounded ACP v1 transport for one local Devin process. No shell, file, terminal,
 * permission, or host-context capability is supplied implicitly. The caller owns
 * trust preflight, assignment policy, permission decisions, and task acceptance.
 */
export class AcpClient {
  constructor({ executable, cwd, model = 'swe-2-medium', onUpdate, onPermission, onRequest, onExit,
    stderrPath, requestHandlers = {}, requestTimeoutMs = 30_000, promptTimeoutMs = 900_000 } = {}) {
    if (process.platform === 'win32') throw new AcpError('UNSUPPORTED_PLATFORM', 'The local ACP backend requires POSIX process groups.');
    if (!path.isAbsolute(executable || '') || !path.isAbsolute(cwd || '')) {
      throw new AcpError('INVALID_PATH', 'ACP executable and cwd must be absolute paths.');
    }
    if (!SWE_MODELS.has(model)) throw new AcpError('MODEL_NOT_ALLOWED', 'Select exactly swe-2-medium, swe-2-high, or swe-2-max.');
    for (const value of [requestTimeoutMs, promptTimeoutMs]) {
      if (!Number.isInteger(value) || value < 1 || value > 3_600_000) throw new AcpError('INVALID_TIMEOUT', 'ACP timeouts must be between 1 and 3600000 milliseconds.');
    }
    this.executable = executable;
    this.cwd = cwd;
    this.model = model;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.stderrPath = stderrPath;
    this.requestHandlers = requestHandlers;
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptTimeoutMs = promptTimeoutMs;
    this.pending = new Map();
    this.incoming = new Map();
    this.sessions = new Map();
    this.activePrompts = new Map();
    this.cancelPromises = new Map();
    this.thoughtToolCalls = new Set();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.updateTail = Promise.resolve();
    this.pendingUpdates = 0;
    this.queuedUpdateBytes = 0;
    this.stderrBytes = 0;
    this.stderrTail = '';
    this.stats = { receivedFrames: 0, droppedThoughtUpdates: 0, stderrTruncated: false };
    this.closed = false;
  }

  get pid() { return this.child?.pid ?? null; }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.closed) throw new AcpError('ACP_CLOSED', 'ACP client is closed.');
    this.startPromise = this.startInner();
    return this.startPromise;
  }

  async startInner() {
    if (this.stderrPath) {
      // The state owner creates private parent directories. Refuse an existing
      // path rather than following a symlink or appending to unrelated content.
      this.stderrFd = fs.openSync(this.stderrPath, 'wx', 0o600);
    }
    try {
      this.child = spawn(this.executable, ['acp', '--model', this.model], {
        cwd: this.cwd, env: childEnvironment(), shell: false, detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.stdout.on('data', chunk => this.consume(chunk));
      this.child.stdout.on('error', error => this.fail(new AcpError('ACP_IO_ERROR', error.message)));
      this.child.stderr.on('data', chunk => this.writeStderr(chunk));
      this.child.stderr.on('error', error => this.fail(new AcpError('ACP_IO_ERROR', error.message)));
      this.child.stdin.on('error', error => this.fail(new AcpError('ACP_IO_ERROR', error.message)));
      this.child.on('error', error => this.fail(new AcpError('ACP_SPAWN_FAILED', error.message)));
      this.child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        const error = new AcpError('ACP_EXITED', `Devin ACP exited (${signal || code}).`, this.exitInfo);
        this.rejectPending(error);
        this.cancelIncoming();
        if (!this.closed) this.fail(error);
        if (this.onExit) Promise.resolve().then(() => this.onExit(this.exitInfo)).catch(() => {});
      });
      const fsCapabilities = {};
      if (typeof this.requestHandlers['fs/read_text_file'] === 'function') fsCapabilities.readTextFile = true;
      if (typeof this.requestHandlers['fs/write_text_file'] === 'function') fsCapabilities.writeTextFile = true;
      const capabilities = {};
      if (Object.keys(fsCapabilities).length) capabilities.fs = fsCapabilities;
      if (TERMINAL_METHODS.every(method => typeof this.requestHandlers[method] === 'function')) capabilities.terminal = true;
      if (typeof this.requestHandlers['elicitation/create'] === 'function') capabilities.elicitation = { form: {} };
      this.initialization = await this.request('initialize', {
        protocolVersion: 1, clientCapabilities: capabilities,
        clientInfo: { name: 'swe2-bridge', title: 'SWE2 bridge', version: '0.2.0' },
      });
      if (this.initialization?.protocolVersion !== 1) throw new AcpError('ACP_PROTOCOL_UNSUPPORTED', 'Devin did not negotiate ACP protocol version 1.');
      return this.initialization;
    } catch (error) {
      await this.close(error);
      throw error;
    }
  }

  async newSession() {
    await this.start();
    const result = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw this.fail(new AcpError('ACP_SESSION_INVALID', 'Devin did not return a session ID.'));
    this.verifyModel(result);
    this.sessions.set(result.sessionId, result);
    return result;
  }

  async loadSession(sessionId) {
    await this.start();
    if (!this.initialization?.agentCapabilities?.loadSession) throw new AcpError('ACP_LOAD_UNSUPPORTED', 'Devin does not advertise session loading.');
    this.validateSessionId(sessionId);
    const result = await this.request('session/load', { sessionId, cwd: this.cwd, mcpServers: [] });
    // A resumable exact model is required even though ACP permits an empty load
    // result. Unknown model identity is not permission to submit inference.
    this.verifyModel(result);
    const metadata = { ...result, sessionId };
    this.sessions.set(sessionId, metadata);
    return metadata;
  }

  verifyModel(metadata) {
    const resolved = selectedModel(metadata);
    if (resolved !== this.model) {
      throw this.fail(new AcpError('MODEL_IDENTITY_UNVERIFIED', `Requested ${this.model}; Devin reported ${typeof resolved === 'string' ? resolved : 'no exact model identity'}.`));
    }
    return resolved;
  }

  async setMode(sessionId, mode) {
    this.requireSession(sessionId);
    if (!['ask', 'accept-edits'].includes(mode)) throw new AcpError('ACP_MODE_NOT_ALLOWED', 'Only ask and accept-edits modes are supported; broad auto-approval modes are unavailable.');
    const result = await this.request('session/set_config_option', { sessionId, configId: 'mode', value: mode });
    const modeOption = result?.configOptions?.find(option => option.category === 'mode' || option.id === 'mode');
    if (modeOption?.currentValue !== mode) throw this.fail(new AcpError('ACP_MODE_UNVERIFIED', 'Devin did not confirm the requested permission mode.'));
    if (selectedModel(result) !== undefined) this.verifyModel(result);
    this.sessions.set(sessionId, { ...this.sessions.get(sessionId), ...result });
    return result;
  }

  async prompt(sessionId, contentBlocks, { timeoutMs = this.promptTimeoutMs } = {}) {
    this.requireSession(sessionId);
    if (this.activePrompts.has(sessionId)) throw new AcpError('ACP_SESSION_BUSY', 'Only one prompt may run in a session at a time.');
    if (!Array.isArray(contentBlocks) || !contentBlocks.length) throw new AcpError('ACP_CONTENT_INVALID', 'Provide at least one ACP content block.');
    const supported = this.initialization.agentCapabilities?.promptCapabilities || {};
    for (const block of contentBlocks) {
      if (!block || !['text', 'resource_link', 'image', 'resource'].includes(block.type)) throw new AcpError('ACP_CONTENT_UNSUPPORTED', 'Only text, resource links, supported images, and embedded resources are accepted.');
      if ((block.type === 'image' && !supported.image) || (block.type === 'resource' && !supported.embeddedContext)) throw new AcpError('ACP_CONTENT_UNSUPPORTED', `Devin does not advertise ${block.type} input.`);
    }
    const promise = this.request('session/prompt', { sessionId, prompt: contentBlocks }, { timeoutMs });
    this.activePrompts.set(sessionId, promise);
    try {
      const result = await promise;
      await this.flushUpdates();
      if (this.failure) throw this.failure;
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(result?.stopReason)) {
        throw new AcpError('ACP_RESULT_UNVERIFIED', 'Devin did not return a recognized prompt stop reason.');
      }
      return result;
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }

  async cancel(sessionId) {
    this.validateSessionId(sessionId);
    if (this.cancelPromises.has(sessionId)) return this.cancelPromises.get(sessionId);
    const promise = this.cancelInner(sessionId);
    this.cancelPromises.set(sessionId, promise);
    try { return await promise; }
    finally { this.cancelPromises.delete(sessionId); }
  }

  async cancelInner(sessionId) {
    if (this.closed || this.exitInfo) return { acknowledged: false, processStopped: !groupAlive(this.pid) };
    const active = this.activePrompts.get(sessionId);
    await this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    this.cancelIncoming(sessionId);
    if (!active) return { acknowledged: true, processStopped: false };
    const response = await Promise.race([
      active.then(result => ({ result }), error => ({ error })),
      sleep(3_000).then(() => null),
    ]);
    if (response?.result?.stopReason === 'cancelled') return { acknowledged: true, processStopped: false };
    // A transport cancellation request alone is not proof that commands stopped.
    // If Devin does not confirm, stop the owned process group before returning.
    await this.close(new AcpError('ACP_CANCELLED', 'ACP prompt cancelled by its owner.'));
    return { acknowledged: false, processStopped: !groupAlive(this.pid) };
  }

  validateSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new AcpError('ACP_SESSION_INVALID', 'Invalid ACP session ID.');
  }

  requireSession(sessionId) {
    this.validateSessionId(sessionId);
    if (!this.sessions.has(sessionId)) throw new AcpError('ACP_SESSION_UNKNOWN', 'Create or load this session before prompting it.');
    if (this.closed || this.exitInfo) throw new AcpError('ACP_CLOSED', 'ACP client is no longer running.');
  }

  async request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed || this.exitInfo) throw new AcpError('ACP_CLOSED', 'ACP client is no longer running.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new AcpError('INVALID_TIMEOUT', 'ACP timeout is outside its supported range.');
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new AcpError('ACP_REQUEST_LIMIT', 'Too many pending ACP requests.');
    const id = ++this.nextId;
    let timer;
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => this.fail(new AcpError('ACP_TIMEOUT', `Devin did not answer ${method} within ${timeoutMs}ms.`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, sessionId: params?.sessionId });
    });
    // A process can fail while its request frame is still being written.
    // The returned promise still rejects, but it has an immediate handler.
    promise.catch(() => {});
    try { await this.send({ jsonrpc: '2.0', id, method, params }); }
    catch (error) {
      this.pending.delete(id);
      clearTimeout(timer);
      // Consume the response promise before propagating a write failure.
      promise.catch(() => {});
      this.fail(error);
      throw error;
    }
    return promise;
  }

  async send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new AcpError('ACP_CLOSED', 'ACP input stream is closed.');
    const frame = Buffer.from(`${JSON.stringify(message)}\n`);
    if (frame.length > MAX_FRAME_BYTES) throw new AcpError('ACP_FRAME_TOO_LARGE', 'ACP message exceeds the 8 MiB frame limit.');
    if (this.child.stdin.writableLength + frame.length > 2 * MAX_FRAME_BYTES) throw new AcpError('ACP_WRITE_LIMIT', 'ACP outbound buffer limit reached.');
    await new Promise((resolve, reject) => this.child.stdin.write(frame, error => error ? reject(new AcpError('ACP_IO_ERROR', error.message)) : resolve()));
  }

  consume(chunk) {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.buffer.length + segment.length > MAX_FRAME_BYTES) return this.fail(new AcpError('ACP_FRAME_TOO_LARGE', 'Devin emitted an ACP frame larger than 8 MiB.'));
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, segment]) : Buffer.from(segment);
      if (newline < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!line.length) continue;
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { return this.fail(new AcpError('ACP_PROTOCOL_INVALID', 'Devin emitted invalid JSON on the ACP protocol stream.')); }
      this.stats.receivedFrames++;
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') return this.fail(new AcpError('ACP_PROTOCOL_INVALID', 'Devin emitted an invalid JSON-RPC message.'));
      this.dispatch(message, line.length);
      if (this.closed) return;
    }
  }

  dispatch(message, frameBytes) {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (!['string', 'number'].includes(typeof message.id)) return this.fail(new AcpError('ACP_PROTOCOL_INVALID', 'Invalid ACP request ID.'));
        void this.handleRequest(message).catch(error => this.fail(error));
      } else if (message.method === 'session/update') {
        this.queueUpdate(message.params, frameBytes);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late responses after cancellation are harmless.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new AcpError('ACP_REMOTE_ERROR', String(message.error.message || 'Devin ACP request failed.').slice(0, 4096), { rpcCode: message.error.code }));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new AcpError('ACP_PROTOCOL_INVALID', 'ACP response contains neither result nor error.'));
  }

  queueUpdate(params, frameBytes = 0) {
    const update = params?.update;
    if (!update || typeof params.sessionId !== 'string') return this.fail(new AcpError('ACP_PROTOCOL_INVALID', 'Invalid ACP session update.'));
    if (update.sessionUpdate === 'agent_thought_chunk' || update.kind === 'think' || this.thoughtToolCalls.has(update.toolCallId)) {
      if (update.toolCallId) {
        if (this.thoughtToolCalls.size >= MAX_THOUGHT_TOOLS && !this.thoughtToolCalls.has(update.toolCallId)) return this.fail(new AcpError('ACP_UPDATE_OVERFLOW', 'ACP thought-tool metadata limit reached.'));
        this.thoughtToolCalls.add(update.toolCallId);
      }
      this.stats.droppedThoughtUpdates++;
      return;
    }
    if (update.sessionUpdate === 'config_option_update' && selectedModel(update) !== undefined && selectedModel(update) !== this.model) {
      return this.fail(new AcpError('MODEL_IDENTITY_CHANGED', 'Devin reported a model change away from the requested SWE-2 model.'));
    }
    if (update.sessionUpdate === 'current_model_update' && update.currentModelId !== this.model) return this.fail(new AcpError('MODEL_IDENTITY_CHANGED', 'Devin reported a model change away from the requested SWE-2 model.'));
    if (!this.onUpdate) return;
    if (this.pendingUpdates + 1 > MAX_PENDING_UPDATES || this.queuedUpdateBytes + frameBytes > MAX_QUEUED_UPDATE_BYTES) return this.fail(new AcpError('ACP_UPDATE_OVERFLOW', 'ACP update processing fell behind; evidence may be incomplete.'));
    this.pendingUpdates++;
    this.queuedUpdateBytes += frameBytes;
    this.updateTail = this.updateTail.then(() => this.onUpdate(params)).catch(error => {
      this.fail(new AcpError('ACP_UPDATE_FAILED', `ACP update handler failed: ${String(error?.message || error).slice(0, 1000)}`));
    }).finally(() => { this.pendingUpdates--; this.queuedUpdateBytes -= frameBytes; });
  }

  async handleRequest(message) {
    if (this.incoming.size >= MAX_PENDING_REQUESTS) {
      await this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Too many pending client requests.' } });
      return;
    }
    if (this.incoming.has(message.id)) throw new AcpError('ACP_PROTOCOL_INVALID', 'Duplicate pending ACP request ID.');
    const controller = new AbortController();
    const entry = { method: message.method, params: message.params, controller, settled: false };
    this.incoming.set(message.id, entry);
    const respond = async result => {
      if (entry.settled) return;
      entry.settled = true;
      this.incoming.delete(message.id);
      if (!this.closed && !this.exitInfo) await this.send({ jsonrpc: '2.0', id: message.id, result });
    };
    entry.respond = respond;
    try {
      // A permission request may be in the same stdout chunk as the tool-call
      // notification containing its command. Preserve that causal ordering.
      await this.updateTail;
      if (entry.settled || this.closed || this.exitInfo) return;
      let result;
      if (message.method === 'session/request_permission') {
        if (!Array.isArray(message.params?.options) || !message.params?.toolCall) throw new AcpError('ACP_PERMISSION_INVALID', 'Invalid ACP permission request.');
        result = this.onPermission ? await this.onPermission(message.params, { signal: controller.signal }) : { outcome: { outcome: 'cancelled' } };
        if (entry.settled) return;
        const outcome = result?.outcome?.outcome ? result.outcome : result;
        if (outcome?.outcome !== 'cancelled') {
          const option = message.params.options.find(candidate => candidate.optionId === outcome?.optionId);
          if (outcome?.outcome !== 'selected' || !option || !['allow_once', 'reject_once'].includes(option.kind)) {
            throw new AcpError('ACP_PERMISSION_INVALID', 'Only an offered one-time permission outcome can be selected.');
          }
        }
        result = { outcome };
      } else {
        if (message.method === 'elicitation/create' && message.params?.mode !== 'form') throw new AcpError('ACP_PARAMS_UNSUPPORTED', 'Only ACP form elicitation is supported.');
        const handler = this.requestHandlers[message.method];
        if (typeof handler === 'function') result = await handler(message.params, { signal: controller.signal });
        else if (!FS_METHODS.includes(message.method) && !message.method.startsWith('terminal/') && this.onRequest) result = await this.onRequest(message.method, message.params, { signal: controller.signal });
        else throw new AcpError('ACP_METHOD_UNSUPPORTED', `Client method ${message.method} is not supported.`);
      }
      await respond(result ?? {});
    } catch (error) {
      if (entry.settled) return;
      entry.settled = true;
      this.incoming.delete(message.id);
      if (!this.closed && !this.exitInfo) {
        await this.send({ jsonrpc: '2.0', id: message.id, error: {
          code: error?.code === 'ACP_METHOD_UNSUPPORTED' ? -32601 : error?.code === 'ACP_PARAMS_UNSUPPORTED' ? -32602 : -32603,
          message: String(error?.message || 'Client request failed.').slice(0, 1000),
        } });
      }
    }
  }

  cancelIncoming(sessionId) {
    for (const entry of this.incoming.values()) {
      if (sessionId !== undefined && entry.params?.sessionId !== sessionId) continue;
      entry.controller.abort();
      if (entry.method === 'session/request_permission') void entry.respond({ outcome: { outcome: 'cancelled' } }).catch(() => {});
      else if (entry.method === 'elicitation/create') void entry.respond({ action: 'cancel' }).catch(() => {});
      else { entry.settled = true; }
    }
    for (const [id, entry] of this.incoming) if (entry.settled) this.incoming.delete(id);
  }

  writeStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-8192);
    const retained = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - this.stderrBytes));
    this.stderrBytes += retained.length;
    if (retained.length !== chunk.length) this.stats.stderrTruncated = true;
    if (this.stderrFd !== undefined && retained.length) {
      try { fs.writeSync(this.stderrFd, retained); }
      catch (error) { this.fail(new AcpError('ACP_LOG_FAILED', error.message)); }
    }
  }

  async flushUpdates() {
    let timer;
    try {
      await Promise.race([
        this.updateTail,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(this.fail(new AcpError('ACP_UPDATE_TIMEOUT', 'ACP update handler did not finish; evidence may be incomplete.'))), this.requestTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  fail(error) {
    this.failure ??= error;
    this.rejectPending(error);
    void this.close(error).catch(() => {});
    return error;
  }

  async close(reason = new AcpError('ACP_CLOSED', 'ACP client closed by its owner.')) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInner(reason);
    return this.closePromise;
  }

  async closeInner(reason) {
    this.cancelIncoming();
    this.closed = true;
    this.rejectPending(reason);
    this.child?.stdin?.end();
    const pid = this.pid;
    if (groupAlive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 3_000;
      while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
      if (groupAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        const killDeadline = Date.now() + 3_000;
        while (groupAlive(pid) && Date.now() < killDeadline) await sleep(50);
      }
    }
    if (this.stderrFd !== undefined) { fs.closeSync(this.stderrFd); this.stderrFd = undefined; }
    if (groupAlive(pid)) throw new AcpError('ACP_PROCESS_STILL_RUNNING', 'The owned Devin process group remains active; keep its workspace lock.');
    await this.flushUpdates();
    return { processStopped: true, ...this.exitInfo };
  }
}
