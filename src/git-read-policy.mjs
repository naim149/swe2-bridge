import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CONFIG_BYTES = 16384;
const DRIVER_LIMIT = 64;

function fault(code, message) {
  return Object.assign(new Error(message), { code, state: 'blocked', retryable: false });
}

/** Build a bounded, local-only Git read policy; no caller/environment Git overrides survive. */
export async function createRestrictedGitReadPolicy(cwd, { environment = {}, deadline = Date.now() + 20000, timeout = 10000 } = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  Object.assign(env, {
    TERM: 'dumb', NO_COLOR: '1', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1',
  });
  const prefix = ['--no-pager', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.renameLimit=1000'];
  async function configKeys(pattern) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fault('REVIEW_PACKET_TIMEOUT', 'Restricted Git configuration inspection exceeded its bounded deadline.');
    let data;
    try {
      data = (await exec('git', [...prefix, 'config', '-z', '--name-only', '--get-regexp', pattern], {
        cwd, env, encoding: 'buffer', timeout: Math.min(timeout, remaining), maxBuffer: CONFIG_BYTES + 1,
      })).stdout;
    } catch (error) {
      if (error.code === 1) return [];
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw fault('REVIEW_FILTER_CONFIG_LIMIT', `Restricted Git configuration exceeds ${CONFIG_BYTES} bytes.`);
      if (error.killed || error.signal) throw fault('REVIEW_PACKET_TIMEOUT', 'Restricted Git configuration inspection could not finish within its bounded deadline.');
      throw fault('REVIEW_GIT_CONFIG_UNAVAILABLE', 'Cannot inspect local Git configuration safely; no external helpers or fetches were attempted.');
    }
    if (data.length > CONFIG_BYTES) throw fault('REVIEW_FILTER_CONFIG_LIMIT', `Restricted Git configuration exceeds ${CONFIG_BYTES} bytes.`);
    if (!data.length) return [];
    if (data.at(-1) !== 0) throw fault('REVIEW_GIT_CONFIG_UNAVAILABLE', 'Git configuration keys were not complete NUL-terminated records.');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data).slice(0, -1).split('\0'); }
    catch { throw fault('REVIEW_GIT_CONFIG_UNAVAILABLE', 'Git configuration keys are not valid UTF-8.'); }
  }
  // Reject these even on Git versions that predate GIT_NO_LAZY_FETCH. A false
  // promisor setting is rejected conservatively rather than probing a remote.
  const promisor = await configKeys('^(extensions\\.partialclone|remote\\..*\\.promisor)$');
  if (promisor.length) throw fault('REVIEW_PARTIAL_CLONE_UNSUPPORTED', 'Review reads require locally complete Git objects; a promisor/partial-clone repository must be materialized separately before review.');
  const keys = await configKeys('^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(funcname|xfuncname))$');
  const filters = new Set(keys.filter(key => key.startsWith('filter.')).map(key => key.replace(/\.(clean|smudge|process|required)$/, '')));
  const functions = new Set(keys.filter(key => key.startsWith('diff.')).map(key => key.replace(/\.(funcname|xfuncname)$/, '')));
  if (filters.size + functions.size > DRIVER_LIMIT) throw fault('REVIEW_FILTER_CONFIG_LIMIT', `Too many configured Git drivers to disable within the ${DRIVER_LIMIT}-driver limit.`);
  // Status and worktree diffs can invoke conversion filters. Disable each
  // local driver for these commands only; never write repository configuration.
  for (const driver of filters) prefix.push('-c', `${driver}.clean=`, '-c', `${driver}.smudge=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`);
  for (const driver of functions) prefix.push('-c', `${driver}.funcname=^$`, '-c', `${driver}.xfuncname=^$`);
  return { prefix, env, conversion_filters_disabled: filters.size > 0, function_drivers_disabled: functions.size };
}
