import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizeReview, prepareReviewPacket, REVIEW_PACKET_LIMITS as limits } from '../src/review-packet.mjs';
import { normalizeAssignment, prepareContent, inspectReadiness, assessChanges } from '../src/assignment.mjs';
import { childEnvironment, gitSnapshot, snapshotEvidence } from '../src/runner.mjs';

const exec = promisify(execFile);
const hash = text => createHash('sha256').update(text).digest('hex');
const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t, { format = 'sha1' } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'swe2 review fixture '));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const cwd = path.join(parent, 'repository with spaces');
  await fs.mkdir(cwd);
  const env = { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = async (args, options = {}) => (await exec('git', args, { cwd, env, timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout.trim();
  await git(['init', '--quiet', `--object-format=${format}`]);
  await git(['config', 'user.name', 'Review fixture']);
  await git(['config', 'user.email', 'review-fixture@example.invalid']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  await git(['config', 'commit.gpgsign', 'false']);
  const write = async (name, data) => {
    await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await fs.writeFile(path.join(cwd, name), data);
  };
  const commit = async (message = 'fixture', { add = true, allowEmpty = false } = {}) => {
    if (add) await git(['add', '-A']);
    await git(['commit', '--quiet', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  return { parent, cwd, git, write, commit };
}

async function pair(t, options) {
  const repo = await fixture(t, options);
  await repo.write('source.txt', 'before\n');
  const base_sha = await repo.commit('base');
  await repo.write('source.txt', 'after\n');
  const head_sha = await repo.commit('head');
  return { ...repo, base_sha, head_sha, review: { base_sha, head_sha } };
}

const diffText = packet => packet.content[1].text.slice(packet.content[1].text.indexOf('\n\n') + 2);

test('review intent requires exact commit IDs and a read profile', async t => {
  const repo = await fixture(t);
  const value = { base_sha: 'A'.repeat(40), head_sha: 'B'.repeat(40) };
  assert.deepEqual(normalizeReview(value), { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) });
  assert.equal(normalizeReview(undefined), undefined);
  for (const invalid of [null, [], 'HEAD', { ...value, pr: 1 }]) assert.throws(() => normalizeReview(invalid), { code: 'INVALID_REVIEW' });
  for (const invalid of [{}, { base_sha: 'HEAD', head_sha: value.head_sha }, { ...value, head_sha: 'a'.repeat(12) },
    { ...value, head_sha: ` ${value.head_sha}` }, { ...value, head_sha: 'a'.repeat(64) }]) {
    assert.throws(() => normalizeReview(invalid), { code: 'INVALID_REVIEW_COMMIT' });
  }
  for (const profile of ['edit', 'edit_check']) {
    await assert.rejects(normalizeAssignment({ task: 'Review.', cwd: repo.cwd, profile, owned_paths: ['source.txt'], review: value }), { code: 'REVIEW_PROFILE_REQUIRED' });
  }
});

test('existing assignments keep review absent from normalized intent and prepared content', async t => {
  const { cwd } = await fixture(t);
  const assignment = await normalizeAssignment({ task: 'Read source.', cwd, profile: 'read' });
  assert.equal(Object.hasOwn(assignment, 'review'), false);
  const prepared = await prepareContent(assignment);
  assert.equal(Object.hasOwn(prepared, 'review'), false);
  assert.equal(prepared.content.length, 1);
  assert.doesNotMatch(prepared.content[0].text, /"review"/);
});

test('restricted snapshots preserve ordinary file evidence and add coverage only when opted in', async t => {
  const repo = await pair(t);
  await repo.write('source.txt', 'observed local modification\n');
  const ordinary = await gitSnapshot(repo.cwd);
  const restricted = await gitSnapshot(repo.cwd, { review: true });
  for (const key of ['repository', 'files', 'head', 'index', 'tree']) assert.deepEqual(restricted[key], ordinary[key]);
  assert.deepEqual(Object.keys(snapshotEvidence(ordinary)), ['repository', 'files', 'head', 'index', 'tree']);
  assert.equal(Object.hasOwn(ordinary, 'complete'), false);
  assert.equal(restricted.complete, true);
  const evidence = snapshotEvidence(restricted);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.coverage, restricted.coverage);
  assert.deepEqual(evidence.limitations, restricted.limitations);
  assert.equal(evidence.restricted_git.external_helpers_disabled, true);
  const assignment = await normalizeAssignment({ task: 'Review.', cwd: repo.cwd, profile: 'read' });
  assert.equal(assessChanges(evidence, evidence, assignment).evidence.completeness, 'complete');
});

test('a complete packet preserves comparison identity through assignment preparation', async t => {
  const { cwd, review } = await pair(t);
  const assignment = await normalizeAssignment({ task: 'Review the supplied comparison.', cwd, profile: 'read', base_sha: review.head_sha, review });
  const prepared = await prepareContent(assignment);
  const direct = await prepareReviewPacket(cwd, review);
  assert.deepEqual(assignment.review, review);
  assert.equal(assignment.base_sha, review.head_sha);
  assert.deepEqual(prepared.review, direct.metadata);
  assert.equal(direct.metadata.base_sha, review.base_sha);
  assert.equal(direct.metadata.head_sha, review.head_sha);
  assert.equal(direct.metadata.complete, true);
  assert.equal(direct.metadata.truncated, false);
  assert.deepEqual(direct.metadata.omitted, []);
  assert.deepEqual(direct.metadata.changed_files.map(file => [file.status, file.path]), [['M', 'source.txt']]);
  assert.equal(direct.metadata.checkout.head, review.head_sha);
  assert.equal(direct.metadata.checkout.dirty, false);
  assert.equal(direct.metadata.diff.sha256, hash(diffText(direct)));
  assert.equal(direct.metadata.content_sha256, hash(JSON.stringify(direct.content)));
  assert.equal(direct.metadata.content_bytes, Buffer.byteLength(JSON.stringify(direct.content)));
  assert.match(diffText(direct), /-before\n\+after\n/);
  assert.match(prepared.content[1].text, /Do not substitute current checkout/);
});

test('immutable head instructions and packet identity survive a different dirty checkout', async t => {
  const repo = await fixture(t);
  await fs.writeFile(path.join(repo.parent, 'AGENTS.md'), 'OUTSIDE REPOSITORY INSTRUCTIONS\n');
  await repo.write('AGENTS.md', 'root base instructions\n');
  await repo.write('src/AGENTS.md', 'nested base instructions\n');
  await repo.write('src/deep/source.txt', 'before\n');
  await repo.write('unrelated/AGENTS.md', 'UNRELATED INSTRUCTIONS\n');
  const base_sha = await repo.commit('base');
  await repo.write('AGENTS.md', 'root head instructions\n');
  await repo.write('src/AGENTS.md', 'nested head instructions\n');
  await repo.write('src/deep/source.txt', 'after\n');
  const head_sha = await repo.commit('head');
  const review = { base_sha, head_sha };
  const before = await prepareReviewPacket(repo.cwd, review);
  assert.deepEqual(before.metadata.instructions.map(file => file.path), ['AGENTS.md', 'src/AGENTS.md']);
  assert.ok(before.metadata.instructions.every(file => file.revision === head_sha));
  assert.ok(before.metadata.instructions[1].applies_to.includes('src/deep/source.txt'));
  await repo.write('checkout-only.txt', 'different HEAD\n');
  const checkoutHead = await repo.commit('unrelated later checkout');
  await repo.write('src/deep/source.txt', 'DIRTY WORKSPACE SUBSTITUTE\n');
  await repo.write('AGENTS.md', 'DIRTY INSTRUCTIONS\n');
  await repo.write('.gitattributes', '*.txt binary\n');
  const after = await prepareReviewPacket(repo.cwd, review);
  assert.equal(after.metadata.packet_sha256, before.metadata.packet_sha256);
  assert.equal(after.metadata.diff.sha256, before.metadata.diff.sha256);
  assert.notEqual(after.metadata.content_sha256, before.metadata.content_sha256);
  assert.equal(after.metadata.checkout.head, checkoutHead);
  assert.equal(after.metadata.checkout.matches_review_head, false);
  assert.equal(after.metadata.checkout.dirty, true);
  assert.match(after.content.map(block => block.text).join('\n'), /nested head instructions/);
  assert.doesNotMatch(after.content.map(block => block.text).join('\n'), /DIRTY WORKSPACE SUBSTITUTE|DIRTY INSTRUCTIONS|UNRELATED INSTRUCTIONS|OUTSIDE REPOSITORY INSTRUCTIONS/);
});

test('renamed and deleted files include both path scopes and never reuse deleted head instructions', async t => {
  const repo = await fixture(t);
  await repo.write('AGENTS.md', 'root instructions\n');
  await repo.write('old/AGENTS.md', 'source scope\n');
  await repo.write('new/AGENTS.md', 'destination scope\n');
  await repo.write('removed/AGENTS.md', 'removed instructions\n');
  await repo.write('old/name.txt', 'same body retained\n');
  await repo.write('removed/file.txt', 'deleted body\n');
  const base_sha = await repo.commit('base');
  await fs.rename(path.join(repo.cwd, 'old/name.txt'), path.join(repo.cwd, 'new/name.txt'));
  await fs.rm(path.join(repo.cwd, 'removed'), { recursive: true });
  const head_sha = await repo.commit('rename and delete');
  const packet = await prepareReviewPacket(repo.cwd, { base_sha, head_sha });
  const rename = packet.metadata.changed_files.find(file => file.status.startsWith('R'));
  assert.equal(rename.status, 'R100');
  assert.equal(rename.previous_path, 'old/name.txt');
  assert.equal(rename.path, 'new/name.txt');
  assert.ok(packet.metadata.changed_files.some(file => file.status === 'D' && file.path === 'removed/file.txt'));
  assert.deepEqual(packet.metadata.instructions.map(file => file.path), ['AGENTS.md', 'new/AGENTS.md', 'old/AGENTS.md']);
  assert.deepEqual(packet.metadata.instructions.find(file => file.path === 'old/AGENTS.md').applies_to, ['old/name.txt']);
  assert.match(diffText(packet), /rename from old\/name.txt\nrename to new\/name.txt/);
  assert.match(diffText(packet), /-deleted body/);
});

test('same commits and distinct commits with identical trees stop preflight before CLI inspection', async t => {
  const repo = await pair(t);
  const empty = await repo.commit('empty', { allowEmpty: true });
  for (const review of [{ base_sha: repo.head_sha, head_sha: repo.head_sha }, { base_sha: repo.head_sha, head_sha: empty }]) {
    await assert.rejects(prepareReviewPacket(repo.cwd, review), { code: 'REVIEW_EMPTY_COMPARISON', state: 'blocked' });
    const assignment = await normalizeAssignment({ task: 'Review.', cwd: repo.cwd, profile: 'read', review });
    const ready = await inspectReadiness(assignment);
    assert.equal(ready.ready, false);
    assert.deepEqual(ready.blockers.map(blocker => blocker.code), ['REVIEW_EMPTY_COMPARISON']);
    assert.equal(ready.review.complete, false);
    assert.equal(ready.cli.path, null);
    assert.equal(ready.model.catalog_checked_at, null);
  }
});

test('missing objects and non-commit objects are rejected without peeling tags or moving refs', async t => {
  const repo = await pair(t);
  const absent = 'f'.repeat(40);
  for (const review of [{ base_sha: absent, head_sha: repo.head_sha }, { base_sha: repo.base_sha, head_sha: absent }]) {
    await assert.rejects(prepareReviewPacket(repo.cwd, review), { code: 'REVIEW_COMMIT_MISSING' });
  }
  await repo.git(['tag', '-a', 'fixture-tag', '-m', 'fixture tag']);
  for (const expression of ['HEAD:source.txt', 'HEAD^{tree}', 'fixture-tag']) {
    const object = await repo.git(['rev-parse', expression]);
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.base_sha, head_sha: object }), { code: 'REVIEW_COMMIT_REQUIRED' });
  }
});

test('binary, invalid UTF-8, and externally stored content never become a partial text review', async t => {
  for (const [name, content, code] of [
    ['binary', Buffer.from([65, 0, 66]), 'REVIEW_BINARY_UNSUPPORTED'],
    ['invalid-utf8', Buffer.from([0xff, 0xfe]), 'REVIEW_BINARY_UNSUPPORTED'],
    ['lfs', `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 42\n`, 'REVIEW_EXTERNAL_CONTENT'],
  ]) await t.test(name, async t => {
    const repo = await fixture(t);
    await repo.write('input', content);
    const base_sha = await repo.commit('base');
    await repo.write('input', 'plain replacement\n');
    const head_sha = await repo.commit('head');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code });
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: head_sha, head_sha: base_sha }), { code });
  });
});

test('a changed file above its exact byte limit is blocked before its body is read', async t => {
  const repo = await pair(t);
  await repo.write('large.txt', Buffer.alloc(limits.changed_file_bytes + 1, 'a'));
  const head_sha = await repo.commit('large');
  await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha }), error => {
    assert.equal(error.code, 'REVIEW_FILE_LIMIT');
    assert.equal(error.details.bytes, limits.changed_file_bytes + 1);
    assert.equal(error.details.limit, limits.changed_file_bytes);
    return true;
  });
});

test('exact per-file boundary works while an oversized complete diff is rejected', async t => {
  const repo = await pair(t);
  await repo.write('large-a.txt', Buffer.alloc(limits.changed_file_bytes, 'a'));
  const boundary = await repo.commit('boundary');
  const packet = await prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha: boundary });
  assert.equal(packet.metadata.changed_files[0].head_bytes, limits.changed_file_bytes);
  await repo.write('large-b.txt', Buffer.alloc(limits.changed_file_bytes, 'b'));
  const head_sha = await repo.commit('diff overflow');
  await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha }), { code: 'REVIEW_DIFF_LIMIT' });
});

test('aggregate changed-blob reads have a hard budget before diff generation', async t => {
  const repo = await pair(t);
  const count = Math.floor(limits.total_changed_blob_bytes / limits.changed_file_bytes) + 1;
  for (let index = 0; index < count; index++) {
    const prefix = `${index}:`;
    await repo.write(`large-${index}.txt`, prefix + 'x'.repeat(limits.changed_file_bytes - prefix.length));
  }
  const head_sha = await repo.commit('blob budget overflow');
  await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha }), error => {
    assert.equal(error.code, 'REVIEW_BLOB_BUDGET');
    assert.ok(error.details.bytes > limits.total_changed_blob_bytes);
    return true;
  });
});

test('instruction file and aggregate limits reject complete packet preparation', async t => {
  await t.test('one instruction', async t => {
    const repo = await fixture(t);
    await repo.write('AGENTS.md', Buffer.alloc(limits.instruction_file_bytes + 1, 'a'));
    await repo.write('source.txt', 'before\n');
    const base_sha = await repo.commit('base');
    await repo.write('source.txt', 'after\n');
    const head_sha = await repo.commit('head');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code: 'REVIEW_INSTRUCTION_FILE_LIMIT' });
  });
  await t.test('aggregate instructions', async t => {
    const repo = await fixture(t);
    for (let index = 0; index < 5; index++) {
      await repo.write(`scope${index}/AGENTS.md`, Buffer.alloc(limits.instruction_file_bytes, String(index)));
      await repo.write(`scope${index}/source.txt`, 'before\n');
    }
    const base_sha = await repo.commit('base');
    for (let index = 0; index < 5; index++) await repo.write(`scope${index}/source.txt`, 'after\n');
    const head_sha = await repo.commit('head');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code: 'REVIEW_INSTRUCTION_BUDGET' });
  });
});

test('changed-file and instruction-count limits do not silently drop paths', async t => {
  await t.test('changed file count', async t => {
    const repo = await pair(t);
    for (let index = 0; index <= limits.changed_files; index++) await repo.write(`file${index}.txt`, `file ${index}\n`);
    const head_sha = await repo.commit('many files');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha }), { code: 'REVIEW_CHANGED_FILES_LIMIT' });
  });
  await t.test('instruction count', async t => {
    const repo = await fixture(t);
    for (let index = 0; index <= limits.instruction_files; index++) {
      await repo.write(`scope${index}/AGENTS.md`, `scope ${index}\n`);
      await repo.write(`scope${index}/source.txt`, 'before\n');
    }
    const base_sha = await repo.commit('base');
    for (let index = 0; index <= limits.instruction_files; index++) await repo.write(`scope${index}/source.txt`, 'after\n');
    const head_sha = await repo.commit('head');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code: 'REVIEW_INSTRUCTIONS_LIMIT' });
  });
});

test('serialized packet budget includes escaped text instead of truncating content', async t => {
  const repo = await fixture(t);
  await repo.write('AGENTS.md', '\\'.repeat(32 * 1024));
  await repo.write('source.txt', 'before\n');
  const base_sha = await repo.commit('base');
  await repo.write('large-a.txt', '\\'.repeat(250 * 1024));
  await repo.write('large-b.txt', '\\'.repeat(250 * 1024 - 1));
  const head_sha = await repo.commit('escaped packet overflow');
  await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code: 'REVIEW_PACKET_LIMIT' });
});

test('changed gitlinks and non-regular AGENTS instructions are rejected without following them', async t => {
  await t.test('gitlink', async t => {
    const repo = await pair(t);
    await repo.git(['update-index', '--add', '--cacheinfo', `160000,${repo.head_sha},vendor`]);
    const head_sha = await repo.commit('gitlink', { add: false });
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: repo.head_sha, head_sha }), { code: 'REVIEW_GITLINK_UNSUPPORTED' });
  });
  await t.test('symlink instruction', async t => {
    const repo = await fixture(t);
    const outside = path.join(repo.parent, 'outside-instructions');
    await exec('mkfifo', [outside]);
    await fs.symlink(outside, path.join(repo.cwd, 'AGENTS.md'));
    await repo.write('source.txt', 'before\n');
    const base_sha = await repo.commit('base');
    await repo.write('source.txt', 'after\n');
    const head_sha = await repo.commit('head');
    await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha, head_sha }), { code: 'REVIEW_INSTRUCTIONS_UNSUPPORTED' });
  });
});

test('packet and restricted snapshots never invoke configured helpers; ordinary snapshots retain their behavior', async t => {
  const repo = await fixture(t);
  await repo.write('.gitattributes', '*.txt diff=tripwire filter=tripwire\n');
  await repo.write('source.txt', 'before\n\ncontext\n');
  const base_sha = await repo.commit('base');
  await repo.write('source.txt', 'after\n\ncontext\n');
  const head_sha = await repo.commit('head');
  const review = { base_sha, head_sha };
  const before = await prepareReviewPacket(repo.cwd, review);
  const marker = path.join(repo.parent, 'helper-ran');
  const helper = path.join(repo.parent, 'helper.sh');
  await fs.writeFile(helper, `#!/bin/sh\nprintf invoked > ${quoted(marker)}\nexit 1\n`, { mode: 0o700 });
  const command = quoted(helper);
  await repo.git(['config', 'core.fsmonitor', command]);
  await repo.write('source.txt', 'dirty source triggers status filtering\n');
  // Await a successful ordinary snapshot so every parallel Git subprocess has
  // finished before checking the restricted path with the same marker.
  await gitSnapshot(repo.cwd);
  assert.equal(await fs.readFile(marker, 'utf8'), 'invoked');
  await fs.rm(marker);
  for (const [key, value] of [
    ['diff.external', command], ['diff.tripwire.textconv', command],
    ['filter.tripwire.clean', command], ['filter.tripwire.process', command], ['filter.tripwire.required', 'true'],
    ['core.fsmonitor', command], ['diff.outputIndicatorNew', '!'], ['diff.outputIndicatorOld', '?'],
    ['diff.outputIndicatorContext', '.'], ['diff.suppressBlankEmpty', 'true'],
  ]) await repo.git(['config', key, value]);
  const after = await prepareReviewPacket(repo.cwd, review);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(after.metadata.packet_sha256, before.metadata.packet_sha256);
  assert.equal(after.metadata.checkout.conversion_filters_disabled, true);
  assert.equal(after.metadata.checkout.normal_filter_status_equivalence, false);
  const snapshot = await gitSnapshot(repo.cwd, { review: true });
  const evidence = snapshotEvidence(snapshot);
  assert.equal(snapshot.complete, false);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.restricted_git.conversion_filters_disabled, true);
  assert.ok(evidence.limitations.some(limitation => limitation.includes('conversion filters')));
  const assignment = await normalizeAssignment({ task: 'Review.', cwd: repo.cwd, profile: 'read' });
  const assessed = assessChanges(evidence, evidence, assignment).evidence;
  assert.equal(assessed.completeness, 'incomplete');
  assert.equal(assessed.coverage, evidence.coverage);
  assert.ok(assessed.limitations.includes(evidence.limitations.find(limitation => limitation.includes('conversion filters'))));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('custom hunk-function configuration cannot change immutable packet bytes', async t => {
  const repo = await fixture(t);
  await repo.write('.gitattributes', '*.txt diff=custom\n');
  const body = ['function OriginalHeader() {', ...Array.from({ length: 20 }, (_, index) => `  line ${index}`), '}'].join('\n') + '\n';
  await repo.write('source.txt', body);
  const base_sha = await repo.commit('base');
  await repo.write('source.txt', body.replace('line 12', 'line twelve'));
  const head_sha = await repo.commit('head');
  const review = { base_sha, head_sha };
  const before = await prepareReviewPacket(repo.cwd, review);
  await repo.git(['config', 'diff.custom.xfuncname', '^  line [0-9]+']);
  await repo.git(['config', 'diff.custom.funcname', '^function']);
  const after = await prepareReviewPacket(repo.cwd, review);
  assert.equal(after.metadata.packet_sha256, before.metadata.packet_sha256);
  assert.equal(after.metadata.diff.hunk_headers, 'line_ranges_only');
  assert.equal(diffText(after), diffText(before));
  assert.match(diffText(after), /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
});

test('review reads do not inherit injected global configuration or Git helper environment', async t => {
  const repo = await pair(t);
  const marker = path.join(repo.parent, 'injected-helper-ran');
  const helper = path.join(repo.parent, 'injected-helper.sh');
  const configuration = path.join(repo.parent, 'injected-global.config');
  await fs.writeFile(helper, `#!/bin/sh\nprintf invoked > ${quoted(marker)}\nexit 1\n`, { mode: 0o700 });
  const command = quoted(helper);
  await repo.git(['config', '--file', configuration, 'core.fsmonitor', command]);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: configuration,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: command, GIT_EXTERNAL_DIFF: command };
  await exec('git', ['status', '--porcelain'], { cwd: repo.cwd, env });
  assert.equal(await fs.readFile(marker, 'utf8'), 'invoked');
  await fs.rm(marker);
  const script = [
    `import { prepareReviewPacket } from ${JSON.stringify(new URL('../src/review-packet.mjs', import.meta.url).href)};`,
    `import { gitSnapshot } from ${JSON.stringify(new URL('../src/runner.mjs', import.meta.url).href)};`,
    `await prepareReviewPacket(${JSON.stringify(repo.cwd)}, ${JSON.stringify(repo.review)});`,
    `await gitSnapshot(${JSON.stringify(repo.cwd)}, { review: true });`,
  ].join('\n');
  await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: repo.cwd, env, timeout: 20000 });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('checkout observations do not enter unchanged submodules or invoke their helpers', async t => {
  const repo = await fixture(t);
  const sub = path.join(repo.cwd, 'vendor');
  await fs.mkdir(sub);
  const subGit = args => repo.git(['-C', sub, ...args]);
  await subGit(['init', '--quiet']);
  await subGit(['config', 'user.name', 'Submodule fixture']);
  await subGit(['config', 'user.email', 'submodule@example.invalid']);
  await subGit(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(sub, 'source.txt'), 'submodule\n');
  await subGit(['add', '.']);
  await subGit(['commit', '--quiet', '-m', 'submodule']);
  await repo.write('.gitmodules', '[submodule "vendor"]\npath = vendor\nurl = https://example.invalid/never-fetched\n');
  await repo.write('source.txt', 'before\n');
  const base_sha = await repo.commit('base');
  await repo.write('source.txt', 'after\n');
  const head_sha = await repo.commit('head');
  const marker = path.join(repo.parent, 'submodule-helper-ran');
  const helper = path.join(repo.parent, 'submodule-helper.sh');
  await fs.writeFile(helper, `#!/bin/sh\nprintf invoked > ${quoted(marker)}\nexit 1\n`, { mode: 0o700 });
  await subGit(['config', 'core.fsmonitor', quoted(helper)]);
  await fs.writeFile(path.join(sub, 'source.txt'), 'dirty submodule\n');
  const packet = await prepareReviewPacket(repo.cwd, { base_sha, head_sha });
  assert.equal(packet.metadata.checkout.dirty, false);
  assert.match(packet.metadata.checkout.coverage, /submodule_worktree_changes_excluded/);
  const snapshot = await gitSnapshot(repo.cwd, { review: true });
  const evidence = snapshotEvidence(snapshot);
  assert.equal(evidence.complete, false);
  assert.deepEqual(evidence.restricted_git.submodule_paths, ['vendor']);
  assert.ok(evidence.limitations.some(limitation => limitation.includes('Submodule interiors')));
  const assignment = await normalizeAssignment({ task: 'Review.', cwd: repo.cwd, profile: 'read' });
  const assessed = assessChanges(evidence, evidence, assignment).evidence;
  assert.equal(assessed.completeness, 'incomplete');
  assert.equal(assessed.coverage, evidence.coverage);
  assert.ok(assessed.limitations.includes(evidence.limitations.find(limitation => limitation.includes('Submodule interiors'))));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('replace refs cannot change requested objects and promisor configuration blocks any lazy fetch', async t => {
  const repo = await pair(t);
  const before = await prepareReviewPacket(repo.cwd, repo.review);
  await repo.git(['replace', repo.base_sha, repo.head_sha]);
  const after = await prepareReviewPacket(repo.cwd, repo.review);
  assert.equal(after.metadata.packet_sha256, before.metadata.packet_sha256);
  await repo.git(['replace', '--delete', repo.base_sha]);
  await repo.git(['replace', repo.head_sha, repo.base_sha]);
  const snapshot = await gitSnapshot(repo.cwd, { review: true });
  const expectedBlob = await repo.git(['--no-replace-objects', 'rev-parse', 'HEAD:source.txt']);
  assert.ok(snapshot.tree['source.txt'].includes(expectedBlob));
  await repo.git(['config', 'remote.fixture.url', 'https://example.invalid/never-fetched']);
  await repo.git(['config', 'remote.fixture.promisor', 'true']);
  await assert.rejects(prepareReviewPacket(repo.cwd, repo.review), { code: 'REVIEW_PARTIAL_CLONE_UNSUPPORTED' });
  await assert.rejects(gitSnapshot(repo.cwd, { review: true }), { code: 'REVIEW_PARTIAL_CLONE_UNSUPPORTED' });
});

test('literal Unicode and wildcard-like paths resolve exact nested instructions; control paths block', async t => {
  const repo = await fixture(t);
  await repo.write('scope*/AGENTS.md', 'literal wildcard scope\n');
  await repo.write('scope*/café file.txt', 'before\n');
  await repo.write('scope-other/AGENTS.md', 'wrong wildcard expansion\n');
  const base_sha = await repo.commit('base');
  await repo.write('scope*/café file.txt', 'after\n');
  const head_sha = await repo.commit('head');
  const packet = await prepareReviewPacket(repo.cwd, { base_sha, head_sha });
  assert.deepEqual(packet.metadata.instructions.map(file => file.path), ['scope*/AGENTS.md']);
  assert.equal(packet.metadata.changed_files[0].path, 'scope*/café file.txt');
  await repo.write('control\nname.txt', 'unsupported path\n');
  const invalidHead = await repo.commit('control path');
  await assert.rejects(prepareReviewPacket(repo.cwd, { base_sha: head_sha, head_sha: invalidHead }), { code: 'REVIEW_PATH_UNSUPPORTED' });
});

test('SHA-256 Git repositories retain exact immutable commit identity', async t => {
  const repo = await pair(t, { format: 'sha256' });
  assert.equal(repo.base_sha.length, 64);
  const packet = await prepareReviewPacket(repo.cwd, repo.review);
  assert.deepEqual(packet.metadata.comparison, {
    ...repo.review,
    base_tree: await repo.git(['rev-parse', `${repo.base_sha}^{tree}`]),
    head_tree: await repo.git(['rev-parse', `${repo.head_sha}^{tree}`]),
  });
});
