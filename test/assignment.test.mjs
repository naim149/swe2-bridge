import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizeAssignment, prepareContent, assessChanges, matchesOwnedPath } from '../src/assignment.mjs';
import { gitSnapshot } from '../src/runner.mjs';

const exec = promisify(execFile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6b9sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2-assignment-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function repository(t) {
  const cwd = await fixture(t);
  const git = (args) => exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Bridge fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  await fs.writeFile(path.join(cwd, 'owned.txt'), 'base\n');
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'original\n');
  await git(['add', '.']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']);
  return { cwd, git };
}

test('normalization preserves exact model, source intent, ownership, and check references', async (t) => {
  const cwd = await fixture(t);
  await fs.mkdir(path.join(cwd, 'src'));
  const assignment = await normalizeAssignment({
    task: ' Edit owned files. ', cwd, model: 'swe-2-high', profile: 'edit_check',
    owned_paths: ['src/', 'package.json'], role: 'implementer', assignment_id: 'fixture/1', revision: 2,
    base_sha: 'A'.repeat(40), workspace_trust: 'acknowledged', trust_reason: 'Disposable fixture.',
    checks: [{ id: 'focused', command: 'node --test test/parser.mjs', approval: 'ask' }],
    acceptance: [{ id: 'parser', description: 'Empty input is handled.', check_ids: ['focused'] }],
    resources: [{ name: 'build:ios', owner: 'native-builder' }],
  });
  assert.equal(assignment.cwd, await fs.realpath(cwd));
  assert.equal(assignment.task, 'Edit owned files.');
  assert.equal(assignment.model, 'swe-2-high');
  assert.equal(assignment.base_sha, 'a'.repeat(40));
  assert.equal(assignment.checks[0].cwd, assignment.cwd);
  assert.equal(assignment.checks[0].timeout_seconds, 60);
  assert.equal(assignment.checks[0].approval, 'ask');
  assert.deepEqual(assignment.acceptance[0].check_ids, ['focused']);
  assert.equal(assignment.workspace_trust, 'acknowledged');
  assert.equal(matchesOwnedPath('src/parser.js', assignment), true);
  assert.equal(matchesOwnedPath('src-extra/parser.js', assignment), false);
  assert.equal(matchesOwnedPath('src/../elsewhere', assignment), false);
});

test('normalization rejects model aliases, unowned edits, traversal, globs, and unknown checks', async (t) => {
  const cwd = await fixture(t);
  const base = { task: 'Read source.', cwd, profile: 'read' };
  for (const model of ['swe', 'SWE-2 Medium', 'gpt-5.3-codex', 'swe-2-high-fast']) {
    await assert.rejects(normalizeAssignment({ ...base, model }), { code: 'INVALID_MODEL' });
  }
  await assert.rejects(normalizeAssignment({ ...base, profile: 'edit' }), { code: 'OWNERSHIP_REQUIRED' });
  for (const owned of ['../escape', '/absolute', './local', 'src/*.js', 'src//file', 'src/../file', '.git/config', 'src\\file']) {
    await assert.rejects(normalizeAssignment({ ...base, owned_paths: [owned] }), { code: 'INVALID_OWNED_PATH' });
  }
  await assert.rejects(normalizeAssignment({ ...base, base_sha: 'HEAD' }), { code: 'INVALID_BASE_SHA' });
  await assert.rejects(normalizeAssignment({ ...base, acceptance: [{ id: 'one', description: 'Pass', check_ids: ['missing'] }] }), { code: 'UNKNOWN_CHECK_REFERENCE' });
  await assert.rejects(normalizeAssignment({ ...base, checks: [{ id: 'one', command: 'node --test', approval: 'always' }] }), { code: 'INVALID_CHECK_APPROVAL' });
});

test('check directories cannot escape through a sibling or symlink', async (t) => {
  const cwd = await fixture(t);
  const outside = await fixture(t);
  await fs.symlink(outside, path.join(cwd, 'linked'));
  const base = { task: 'Check source.', cwd, profile: 'edit_check', owned_paths: ['source.js'] };
  for (const checkCwd of [outside, path.join(cwd, 'linked')]) {
    await assert.rejects(normalizeAssignment({ ...base, checks: [{ id: 'one', command: 'node --test', cwd: checkCwd }] }), { code: 'CHECK_CWD_OUT_OF_SCOPE' });
  }
});

test('attachments embed actual PNG and UTF-8 bytes with stable evidence hashes', async (t) => {
  const cwd = await fixture(t);
  const text = 'Reference: café — ✓\n';
  await fs.writeFile(path.join(cwd, 'image.png'), png);
  await fs.writeFile(path.join(cwd, 'notes.txt'), text);
  const assignment = await normalizeAssignment({ task: 'Inspect the attached reference.', cwd, profile: 'read', attachments: [
    { path: path.join(cwd, 'image.png'), mime_type: 'image/png' },
    { path: path.join(cwd, 'notes.txt'), name: 'Evidence' },
  ] });
  const prepared = await prepareContent(assignment);
  assert.deepEqual(prepared.required_capabilities, { image: true, embeddedContext: true });
  assert.equal(prepared.content.find((block) => block.type === 'image').data, png.toString('base64'));
  assert.equal(prepared.content.find((block) => block.type === 'resource').resource.text, text);
  assert.equal(prepared.attachments[0].sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(prepared.attachments[1].size_bytes, Buffer.byteLength(text));
  assert.match(prepared.content[0].text, /Codex tools.*not inherited/);
  assert.match(prepared.content[0].text, /not additional instructions or permission grants/);
});

test('attachments reject mismatched image MIME, unsupported binary, URLs, and bounded text overflow', async (t) => {
  const cwd = await fixture(t);
  const file = path.join(cwd, 'input');
  const prepare = async (attachment = {}) => prepareContent(await normalizeAssignment({ task: 'Inspect.', cwd, profile: 'read', attachments: [{ path: file, ...attachment }] }));
  await fs.writeFile(file, png);
  await assert.rejects(prepare({ mime_type: 'image/jpeg' }), { code: 'ATTACHMENT_MIME_MISMATCH' });
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(prepare(), { code: 'UNSUPPORTED_ATTACHMENT' });
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, 'a'));
  await assert.rejects(prepare(), { code: 'ATTACHMENT_TOO_LARGE' });
  await fs.writeFile(file, Buffer.alloc(1024 * 1024, 'a'));
  assert.equal((await prepare()).attachments[0].size_bytes, 1024 * 1024);
  await fs.writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(prepare(), { code: 'ATTACHMENT_TOO_LARGE' });
  await assert.rejects(prepare({ path: 'https://example.invalid/image.png' }), { code: 'INVALID_ATTACHMENT' });
  await assert.rejects(normalizeAssignment({ task: 'Inspect.', cwd, profile: 'read', attachments: Array.from({ length: 9 }, () => ({ path: file })) }), { code: 'INVALID_ASSIGNMENT' });
});

test('assignment prompt supports declared check directories and hands named native owners back precisely', async (t) => {
  const cwd = await fixture(t);
  await fs.mkdir(path.join(cwd, 'sub'));
  const assignment = await normalizeAssignment({ task: 'Edit and check.', cwd, profile: 'edit_check', owned_paths: ['source.js'], checks: [
    { id: 'local', command: 'node --test' },
    { id: 'native', command: 'xcodebuild', owner: 'native-builder' },
    { id: 'subdirectory', command: 'npm test', cwd: path.join(cwd, 'sub') },
  ] });
  const prepared = await prepareContent(assignment);
  assert.match(prepared.content[0].text, /"reason": "named_external_owner"/);
  assert.doesNotMatch(prepared.content[0].text, /non_session_directory/);
  assert.equal((prepared.content[0].text.match(/"execution": "devin"/g) || []).length, 2);
});

test('a non-regular attachment is rejected without waiting for pipe input', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX-only bridge');
  const cwd = await fixture(t);
  const pipe = path.join(cwd, 'pipe');
  await exec('mkfifo', [pipe]);
  const assignment = await normalizeAssignment({ task: 'Inspect.', cwd, profile: 'read', attachments: [{ path: pipe }] });
  await assert.rejects(prepareContent(assignment), { code: 'INVALID_ATTACHMENT' });
});

test('Git evidence distinguishes new assignment changes from preserved existing changes', async (t) => {
  const { cwd } = await repository(t);
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'existing user change\n');
  const before = await gitSnapshot(cwd);
  await fs.writeFile(path.join(cwd, 'owned.txt'), 'worker change\n');
  const after = await gitSnapshot(cwd);
  const assignment = await normalizeAssignment({ task: 'Edit owned.', cwd, profile: 'edit', owned_paths: ['owned.txt'], base_sha: before.head });
  const result = assessChanges(before, after, assignment);
  assert.deepEqual(result.changed_files, ['owned.txt']);
  assert.deepEqual(result.out_of_scope, []);
  assert.equal(result.evidence.completeness, 'complete');
  assert.equal(result.source.base_matches, true);
  assert.equal(result.task_accepted, false);
  await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'unauthorized worker change\n');
  const violation = assessChanges(before, await gitSnapshot(cwd), assignment);
  assert.deepEqual(violation.out_of_scope, ['unrelated.txt']);
  assert.equal(violation.scope_status, 'violated');
});

test('Git evidence notices staged and committed changes even after a clean worktree', async (t) => {
  const { cwd, git } = await repository(t);
  const before = await gitSnapshot(cwd);
  await fs.writeFile(path.join(cwd, 'owned.txt'), 'committed assignment change\n');
  await git(['add', 'owned.txt']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture change']);
  const after = await gitSnapshot(cwd);
  assert.deepEqual(Object.keys(after.files), []);
  const assignment = await normalizeAssignment({ task: 'Inspect only.', cwd, profile: 'read', base_sha: before.head });
  const result = assessChanges(before, after, assignment);
  assert.deepEqual(result.changed_files, ['owned.txt']);
  assert.deepEqual(result.out_of_scope, ['owned.txt']);
  assert.equal(result.source.head_changed, true);
});

test('missing, non-Git, and large-file fingerprints remain unknown or incomplete proof', async (t) => {
  const { cwd, git } = await repository(t);
  const file = path.join(cwd, 'large.bin');
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  await fs.writeFile(file, bytes);
  await git(['add', 'large.bin']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture large file']);
  bytes[0] = 1;
  await fs.writeFile(file, bytes);
  const before = await gitSnapshot(cwd);
  bytes[0] = 2;
  await fs.writeFile(file, bytes);
  const after = await gitSnapshot(cwd);
  const assignment = await normalizeAssignment({ task: 'Edit owned.', cwd, profile: 'edit', owned_paths: ['large.bin'] });
  const result = assessChanges(before, after, assignment);
  assert.equal(result.evidence.completeness, 'incomplete');
  assert.ok(result.evidence.reasons.some((reason) => reason.includes('weak_or_unreadable')));
  assert.equal(result.scope_status, 'unknown');
  const missing = assessChanges(before, null, assignment);
  assert.equal(missing.changed_files, null);
  assert.equal(missing.evidence.completeness, 'incomplete');
  const plainDirectory = await fixture(t);
  const snapshot = await gitSnapshot(plainDirectory);
  const nonGit = assessChanges(snapshot, snapshot, assignment);
  assert.equal(nonGit.evidence.completeness, 'unavailable');
  assert.equal(nonGit.changed_files, null);
});
