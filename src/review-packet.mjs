import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { childEnvironment } from './runner.mjs';
import { createRestrictedGitReadPolicy } from './git-read-policy.mjs';

const exec = promisify(execFile);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ZERO_SHA = /^0+$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const REVIEW_PACKET_LIMITS = Object.freeze({
  changed_files: 128,
  path_bytes: 4096,
  changed_file_bytes: 256 * 1024,
  total_changed_blob_bytes: 4 * 1024 * 1024,
  diff_bytes: 512 * 1024,
  instruction_files: 64,
  instruction_file_bytes: 64 * 1024,
  total_instruction_bytes: 256 * 1024,
  instruction_candidates: 1024,
  instruction_pathspec_bytes: 128 * 1024,
  metadata_bytes: 2 * 1024 * 1024,
  checkout_status_bytes: 256 * 1024,
  packet_bytes: 1024 * 1024,
  git_timeout_ms: 10000,
  total_timeout_ms: 20000,
});

function fault(code, message, details) {
  return Object.assign(new Error(message), { code, state: 'blocked', retryable: false, ...(details ? { details } : {}) });
}

/** Only comparison intent is normalized here; no checkout or Git access occurs. */
export function normalizeReview(value, { profile = 'read' } = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['base_sha', 'head_sha'].includes(key))) {
    throw fault('INVALID_REVIEW', 'review must contain only explicit base_sha and head_sha commit IDs.');
  }
  if (profile !== 'read') throw fault('REVIEW_PROFILE_REQUIRED', 'A review comparison requires the read profile; it grants no file edits or shell commands.');
  const review = {};
  for (const key of ['base_sha', 'head_sha']) {
    if (typeof value[key] !== 'string' || !FULL_SHA.test(value[key])) {
      throw fault('INVALID_REVIEW_COMMIT', `review.${key} must be an exact full 40- or 64-character hexadecimal commit ID, not a ref or abbreviated hash.`, { field: key });
    }
    review[key] = value[key].toLowerCase();
  }
  if (review.base_sha.length !== review.head_sha.length) throw fault('INVALID_REVIEW_COMMIT', 'Review base and head must use the same Git object hash format.');
  return review;
}

function utf8(bytes, label, code = 'REVIEW_TEXT_UNSUPPORTED') {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw fault(code, `${label} is not valid UTF-8; a complete text review packet cannot be prepared.`); }
  return text;
}

function reviewPath(value) {
  if (!value || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')
      || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw fault('REVIEW_PATH_UNSUPPORTED', 'A changed or instruction path contains unsupported control characters or traversal.');
  }
  const bytes = Buffer.byteLength(value);
  if (bytes > REVIEW_PACKET_LIMITS.path_bytes) throw fault('REVIEW_PATH_LIMIT', `A review path exceeds ${REVIEW_PACKET_LIMITS.path_bytes} bytes.`, { bytes, limit: REVIEW_PACKET_LIMITS.path_bytes });
  return value;
}

function records(bytes, label) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw fault('REVIEW_METADATA_INCOMPLETE', `${label} was not NUL-terminated; no partial packet was accepted.`);
  return utf8(bytes, label, 'REVIEW_PATH_UNSUPPORTED').slice(0, -1).split('\0');
}

function changedFiles(bytes) {
  const fields = records(bytes, 'Git changed-file metadata');
  const files = [];
  for (let index = 0; index < fields.length;) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMRCT])([0-9]{1,3})?$/.exec(fields[index++]);
    if (!header || !FULL_SHA.test(header[3]) || !FULL_SHA.test(header[4]) || index >= fields.length) {
      throw fault('REVIEW_METADATA_INCOMPLETE', 'Git returned an unsupported or incomplete changed-file record.');
    }
    const first = reviewPath(fields[index++]);
    const paired = header[5] === 'R' || header[5] === 'C';
    const current = paired ? reviewPath(fields[index++]) : first;
    if (header[1] === '160000' || header[2] === '160000') {
      throw fault('REVIEW_GITLINK_UNSUPPORTED', `Review includes submodule/gitlink ${JSON.stringify(current)}; its content is not included in a text comparison packet.`, { path: current });
    }
    if (![header[1], header[2]].every(mode => ['000000', '100644', '100755', '120000'].includes(mode))) {
      throw fault('REVIEW_FILE_TYPE_UNSUPPORTED', `Review includes an unsupported file type at ${JSON.stringify(current)}.`, { path: current });
    }
    files.push({
      status: `${header[5]}${header[6] || ''}`, path: current,
      previous_path: paired ? first : null,
      base_mode: header[1], head_mode: header[2],
      base_blob: ZERO_SHA.test(header[3]) ? null : header[3],
      head_blob: ZERO_SHA.test(header[4]) ? null : header[4],
    });
    if (files.length > REVIEW_PACKET_LIMITS.changed_files) {
      throw fault('REVIEW_CHANGED_FILES_LIMIT', `Review exceeds ${REVIEW_PACKET_LIMITS.changed_files} changed files; no files were silently omitted.`, { limit: REVIEW_PACKET_LIMITS.changed_files });
    }
  }
  return files;
}

function instructionCandidates(files) {
  const targets = [...new Set(files.flatMap(file => [file.path, file.previous_path].filter(Boolean)))];
  const candidates = new Set(['AGENTS.md']);
  for (const target of targets) {
    let directory = path.posix.dirname(target);
    while (directory !== '.') {
      candidates.add(`${directory}/AGENTS.md`);
      directory = path.posix.dirname(directory);
    }
  }
  const paths = [...candidates].sort();
  const bytes = paths.reduce((total, entry) => total + Buffer.byteLength(entry) + 1, 0);
  if (paths.length > REVIEW_PACKET_LIMITS.instruction_candidates || bytes > REVIEW_PACKET_LIMITS.instruction_pathspec_bytes) {
    throw fault('REVIEW_INSTRUCTION_SCOPE_LIMIT', 'Applicable AGENTS.md path discovery exceeds the bounded candidate/pathspec limit; no instructions were omitted.',
      { candidates: paths.length, pathspec_bytes: bytes, candidate_limit: REVIEW_PACKET_LIMITS.instruction_candidates, pathspec_limit: REVIEW_PACKET_LIMITS.instruction_pathspec_bytes });
  }
  return { paths, targets };
}

function instructionEntries(bytes, candidates) {
  const entries = records(bytes, 'Git instruction tree metadata').map(record => {
    const entry = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!entry || !FULL_SHA.test(entry[3])) throw fault('REVIEW_METADATA_INCOMPLETE', 'Git returned incomplete instruction tree metadata.');
    const name = reviewPath(entry[4]);
    if (!candidates.has(name)) throw fault('REVIEW_METADATA_INCOMPLETE', 'Git instruction discovery returned an unexpected path.');
    if (entry[2] !== 'blob' || !['100644', '100755'].includes(entry[1])) {
      throw fault('REVIEW_INSTRUCTIONS_UNSUPPORTED', `Applicable ${JSON.stringify(name)} at the review head is not a regular file; symlinks and gitlinks are not followed.`, { path: name, mode: entry[1] });
    }
    return { path: name, blob_sha: entry[3] };
  });
  if (entries.length > REVIEW_PACKET_LIMITS.instruction_files) {
    throw fault('REVIEW_INSTRUCTIONS_LIMIT', `Review requires more than ${REVIEW_PACKET_LIMITS.instruction_files} AGENTS.md files; no instruction files were omitted.`, { limit: REVIEW_PACKET_LIMITS.instruction_files });
  }
  return entries.sort((left, right) => left.path.split('/').length - right.path.split('/').length || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Prepare complete, bounded comparison evidence using only local immutable Git objects. */
export async function prepareReviewPacket(cwd, value) {
  const review = normalizeReview(value);
  if (!review) throw fault('INVALID_REVIEW', 'Supply an explicit review comparison.');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fault('REVIEW_CWD_INVALID', 'Review cwd must be an absolute repository directory.');
  try { cwd = await fs.realpath(cwd); if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); }
  catch { throw fault('REVIEW_CWD_INVALID', 'Review cwd does not exist or is not a directory.'); }
  const deadline = Date.now() + REVIEW_PACKET_LIMITS.total_timeout_ms;
  const policy = await createRestrictedGitReadPolicy(cwd, { environment: childEnvironment(), deadline, timeout: REVIEW_PACKET_LIMITS.git_timeout_ms });
  const { env, prefix } = policy;
  async function git(args, { limit = REVIEW_PACKET_LIMITS.metadata_bytes, code = 'REVIEW_GIT_FAILED', limitCode = code, label = 'Git review evidence', missing = false, attributes = false } = {}) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fault('REVIEW_PACKET_TIMEOUT', `Review packet preparation exceeded ${REVIEW_PACKET_LIMITS.total_timeout_ms} ms; no partial packet was accepted.`);
    try {
      const output = (await exec('git', [...prefix, ...(attributes ? [`--attr-source=${review.head_sha}`] : []), ...args], {
        cwd, env, encoding: 'buffer', timeout: Math.min(remaining, REVIEW_PACKET_LIMITS.git_timeout_ms), maxBuffer: limit + 1,
      })).stdout;
      if (output.length > limit) throw fault(limitCode, `${label} exceeds ${limit} bytes; no partial packet was accepted.`, { byte_limit: limit });
      return output;
    } catch (error) {
      if (error.state === 'blocked') throw error;
      if (missing && error.code === 1) return null;
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw fault(limitCode, `${label} exceeds ${limit} bytes; no partial packet was accepted.`, { byte_limit: limit });
      if (error.killed || error.signal) throw fault('REVIEW_PACKET_TIMEOUT', `${label} could not finish within the bounded preparation deadline.`);
      if (attributes && /unknown option.*attr-source/.test(String(error.stderr))) throw fault('REVIEW_GIT_UNSUPPORTED', 'This Git version cannot read attributes from the immutable head tree (--attr-source); upgrade Git before preparing review evidence.');
      throw fault(code, `${label} could not be read from local Git objects. No fetch, external diff, or text conversion was attempted.`, { git_exit_code: typeof error.code === 'number' ? error.code : null });
    }
  }

  const repository = utf8(await git(['rev-parse', '--show-toplevel'], { code: 'REVIEW_REPOSITORY_REQUIRED', label: 'Review repository' }), 'Repository path').replace(/\r?\n$/, '');
  const repositoryRoot = await fs.realpath(repository);
  const gitVersion = utf8(await git(['--version'], { limit: 1024 }), 'Git version').trim();
  const trees = {};
  for (const key of ['base_sha', 'head_sha']) {
    const sha = review[key];
    const type = utf8(await git(['cat-file', '-t', sha], { limit: 64, code: 'REVIEW_COMMIT_MISSING', label: `review.${key} ${sha}` }), 'Git object type').trim();
    if (type !== 'commit') throw fault('REVIEW_COMMIT_REQUIRED', `review.${key} names a ${type}, not an immutable commit object.`, { field: key });
    const resolved = utf8(await git(['rev-parse', '--verify', `${sha}^{commit}`], { limit: 256, code: 'REVIEW_COMMIT_MISSING', label: `review.${key}` }), 'Resolved commit').trim();
    if (resolved !== sha) throw fault('REVIEW_COMMIT_IDENTITY_MISMATCH', `review.${key} did not resolve to the exact requested commit.`);
    trees[key === 'base_sha' ? 'base_tree' : 'head_tree'] = utf8(await git(['rev-parse', '--verify', `${sha}^{tree}`], { limit: 256, label: 'Comparison tree' }), 'Comparison tree').trim();
  }
  if (trees.base_tree === trees.head_tree) throw fault('REVIEW_EMPTY_COMPARISON', 'The requested base and head have identical trees; there are no changes to review.', review);
  const diffArgs = ['--no-ext-diff', '--no-textconv', '--find-renames=50%', '--ignore-submodules=none', '--no-relative'];
  const raw = await git(['diff', ...diffArgs, '--raw', '-z', '--no-abbrev', review.base_sha, review.head_sha, '--'], { code: 'REVIEW_CHANGED_FILES_UNAVAILABLE', limitCode: 'REVIEW_CHANGED_FILES_LIMIT', label: 'Complete changed-file metadata', attributes: true });
  const files = changedFiles(raw);
  if (!files.length) throw fault('REVIEW_EMPTY_COMPARISON', 'The requested comparison has no changed paths.', review);

  const blobs = new Map();
  let changedBlobBytes = 0;
  async function blob(oid, name, limit, code) {
    if (blobs.has(oid)) {
      const cached = blobs.get(oid);
      if (cached.bytes > limit) throw fault(code, `${JSON.stringify(name)} exceeds its ${limit}-byte limit.`, { path: name, bytes: cached.bytes, limit });
      return cached;
    }
    const count = utf8(await git(['cat-file', '-s', oid], { limit: 64, label: `Size of ${JSON.stringify(name)}` }), 'Blob size').trim();
    const size = Number(count);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(size)) throw fault('REVIEW_METADATA_INCOMPLETE', 'Git returned an invalid blob size.');
    if (size > limit) throw fault(code, `${JSON.stringify(name)} is ${size} bytes, above the ${limit}-byte limit; its content was not omitted from a partial review.`, { path: name, bytes: size, limit });
    const data = await git(['cat-file', 'blob', oid], { limit, code, label: `Content of ${JSON.stringify(name)}` });
    if (data.length !== size) throw fault('REVIEW_BLOB_INCOMPLETE', `Blob size changed while reading ${JSON.stringify(name)}; no packet was accepted.`);
    const text = utf8(data, `Content of ${JSON.stringify(name)}`, 'REVIEW_BINARY_UNSUPPORTED');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fault('REVIEW_BINARY_UNSUPPORTED', `${JSON.stringify(name)} contains binary control bytes; a complete text review is unavailable.`, { path: name });
    if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text)) throw fault('REVIEW_EXTERNAL_CONTENT', `${JSON.stringify(name)} is a Git LFS pointer; its external content was not fetched or included.`, { path: name });
    const entry = { bytes: data.length, sha256: sha256(data), text };
    blobs.set(oid, entry);
    return entry;
  }
  const counted = new Set();
  for (const file of files) {
    for (const side of ['base', 'head']) {
      const oid = file[`${side}_blob`];
      if (!oid) { file[`${side}_bytes`] = 0; file[`${side}_sha256`] = null; continue; }
      const entry = await blob(oid, side === 'base' ? file.previous_path || file.path : file.path, REVIEW_PACKET_LIMITS.changed_file_bytes, 'REVIEW_FILE_LIMIT');
      if (!counted.has(oid)) { counted.add(oid); changedBlobBytes += entry.bytes; }
      if (changedBlobBytes > REVIEW_PACKET_LIMITS.total_changed_blob_bytes) throw fault('REVIEW_BLOB_BUDGET', `Changed file evidence exceeds ${REVIEW_PACKET_LIMITS.total_changed_blob_bytes} bytes; no files were omitted.`, { bytes: changedBlobBytes, limit: REVIEW_PACKET_LIMITS.total_changed_blob_bytes });
      file[`${side}_bytes`] = entry.bytes; file[`${side}_sha256`] = entry.sha256;
    }
  }

  const candidates = instructionCandidates(files);
  const tree = await git(['ls-tree', '-z', '--full-tree', review.head_sha, '--', ...candidates.paths], { label: 'Applicable immutable head-tree AGENTS.md entries' });
  const entries = instructionEntries(tree, new Set(candidates.paths));
  let instructionBytes = 0;
  const instructions = [];
  for (const entry of entries) {
    const data = await blob(entry.blob_sha, entry.path, REVIEW_PACKET_LIMITS.instruction_file_bytes, 'REVIEW_INSTRUCTION_FILE_LIMIT');
    instructionBytes += data.bytes;
    if (instructionBytes > REVIEW_PACKET_LIMITS.total_instruction_bytes) throw fault('REVIEW_INSTRUCTION_BUDGET', `Applicable AGENTS.md content exceeds ${REVIEW_PACKET_LIMITS.total_instruction_bytes} bytes; no instructions were omitted.`, { bytes: instructionBytes, limit: REVIEW_PACKET_LIMITS.total_instruction_bytes });
    const scope = path.posix.dirname(entry.path);
    instructions.push({ ...entry, revision: review.head_sha, scope_directory: scope,
      applies_to: candidates.targets.filter(target => scope === '.' || target.startsWith(`${scope}/`)).sort(),
      bytes: data.bytes, sha256: data.sha256, text: data.text });
  }
  const rawDiff = await git(['diff', ...diffArgs, '--text', '--full-index', '--no-color', '--diff-algorithm=myers', '--no-indent-heuristic', '--no-function-context',
    '--unified=3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    '-O/dev/null', review.base_sha, review.head_sha, '--'],
  { limit: REVIEW_PACKET_LIMITS.diff_bytes, code: 'REVIEW_DIFF_UNAVAILABLE', limitCode: 'REVIEW_DIFF_LIMIT', label: 'Complete comparison diff', attributes: true });
  // Hunk function trailers are heuristic labels, not comparison content. Omit
  // them consistently so local/built-in driver selection cannot change packet
  // identity. Every changed line, context line, and hunk range is retained.
  const diff = utf8(rawDiff, 'Complete comparison diff').replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)[^\n]*$/gm, '$1');
  const diffBytes = Buffer.from(diff);
  if (!diff.trim()) throw fault('REVIEW_DIFF_INCOMPLETE', 'Changed paths were found but the comparison diff is empty; no packet was accepted.');
  const checkoutHeadBytes = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { limit: 256, missing: true, label: 'Checkout HEAD' });
  const checkoutHead = checkoutHeadBytes ? utf8(checkoutHeadBytes, 'Checkout HEAD').trim() : null;
  // Do not recurse into unchanged submodules: they may define their own external
  // filters or fsmonitor helpers outside this repository's disabled drivers.
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'],
    { limit: REVIEW_PACKET_LIMITS.checkout_status_bytes, code: 'REVIEW_CHECKOUT_UNVERIFIED', limitCode: 'REVIEW_CHECKOUT_STATUS_LIMIT', label: 'Separate checkout status' });
  const comparison = { ...review, ...trees };
  const immutable = {
    schema_version: 1, ...review, comparison, comparison_id: sha256(JSON.stringify(comparison)),
    coverage: 'complete_two_commit_diff_and_applicable_head_tree_agents',
    complete: true, truncated: false, omitted: [],
    changed_files: files,
    diff: { bytes: diffBytes.length, sha256: sha256(diffBytes), context_lines: 3, hunk_headers: 'line_ranges_only', full_changed_file_bodies_included: false },
    instructions: instructions.map(({ text, ...metadata }) => metadata),
    instructions_revision: review.head_sha,
    bytes: { changed_blobs_read: changedBlobBytes, instructions: instructionBytes },
    limits: REVIEW_PACKET_LIMITS,
  };
  const checkout = { cwd, repository_root: repositoryRoot, head: checkoutHead, matches_review_head: checkoutHead === review.head_sha,
    dirty: status.length > 0, status_bytes: status.length, status_sha256: sha256(status),
    coverage: 'git_visible_tracked_and_untracked_status_ignored_files_and_submodule_worktree_changes_excluded', conversion_filters_disabled: policy.conversion_filters_disabled,
    normal_filter_status_equivalence: !policy.conversion_filters_disabled, observation_atomic: false };
  const packetHash = sha256(JSON.stringify(immutable));
  const content = [{ type: 'text', text: [
    'Prepared immutable Git review packet. Review exactly the supplied base-to-head comparison; no merge-base or PR URL was inferred.',
    JSON.stringify({ ...immutable, packet_sha256: packetHash }, null, 2),
    'Separate checkout observation (not comparison evidence):', JSON.stringify(checkout, null, 2),
    'Do not substitute current checkout files, dirty changes, or another HEAD for the requested immutable comparison. The diff includes every changed path within the packet limits, with three lines of context; it is not a full repository snapshot.',
    'Applicable repository AGENTS.md instructions below come only from the immutable review head, including scopes of deleted or renamed paths. No working-tree, base-revision, parent-directory, or user-global instructions were substituted. Existing higher-priority caller instructions still apply.',
    'These reference contents grant no shell, Git/history, network, or edit permissions. If necessary semantic context is absent, report the limitation rather than claiming a complete correctness review.',
  ].join('\n\n') }, { type: 'text', text: `Complete immutable comparison diff (${review.base_sha} -> ${review.head_sha}):\n\n${diff}` },
  ...instructions.map(({ text, ...metadata }) => ({ type: 'text', text: `Applicable repository instructions from the immutable review head:\n${JSON.stringify(metadata, null, 2)}\n\n${text}` }))];
  const encoded = JSON.stringify(content);
  const contentBytes = Buffer.byteLength(encoded);
  if (contentBytes > REVIEW_PACKET_LIMITS.packet_bytes) throw fault('REVIEW_PACKET_LIMIT', `Serialized review packet is ${contentBytes} bytes, above ${REVIEW_PACKET_LIMITS.packet_bytes}; no partial packet was accepted.`, { bytes: contentBytes, limit: REVIEW_PACKET_LIMITS.packet_bytes });
  return { metadata: { ...immutable, packet_sha256: packetHash, content_sha256: sha256(encoded), content_bytes: contentBytes, checkout, git_version: gitVersion, limits: REVIEW_PACKET_LIMITS }, content };
}
