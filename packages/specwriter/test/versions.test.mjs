import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BookVersions, Project, loadConfig, initProject } from '../dist/index.js';
import { book, draft, fact } from './boundary-fixture.mjs';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });

test('independent Git checkpoints include WAL state and exact CRLF prose; restore an old version and migrate a bundle', t => {
  const { root, directory, project } = book(t);
  git(root, 'init', '--quiet'); writeFileSync(join(root, 'author.md'), '作者已有暂存内容'); git(root, 'add', 'author.md');
  const index = readFileSync(join(root, '.git/index'));
  writeFileSync(join(root, '.env'), 'QWEN_API_KEY=private-credential-fixture\n');
  mkdirSync(join(root, '.specwriter/graphrag/indexes/fake'), { recursive: true });
  writeFileSync(join(root, '.specwriter/graphrag/indexes/fake/private.index'), 'derived-index');
  const versions = new BookVersions(root);
  const initial = versions.init(project); assert.equal(initial.checkpoint.saved, true);
  assert.equal(loadConfig(root).versioning.autoSave, true);
  const body = '林舟来到城门。\r\n\r\n他等候师父。\r\n';
  draft(project, root, 1, body, { facts: [fact('林舟', '位置', '城门', body)] });
  const accepted = project.commit(1, 'arc'); assert.equal(accepted.versionCheckpoint.saved, true);
  assert.ok(statSync(join(root, '.specwriter/memory/writer.db-wal')).size > 0);
  const checkpoint = accepted.versionCheckpoint.commit;
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  const repo = join(root, '.specwriter/version/repository.git');
  const tree = execFileSync('git', ['--git-dir', repo, 'ls-tree', '-r', '--name-only', checkpoint], { encoding: 'utf8' });
  assert.ok(tree.includes('.specwriter/backup/writer.db'));
  assert.ok(!tree.includes('.env') && !tree.includes('indexes') && !tree.includes('db-wal') && !tree.includes('.git/index'));
  assert.deepEqual(execFileSync('git', ['--git-dir', repo, 'show', `${checkpoint}:manuscript/chapters/0001.md`]), Buffer.from(body));
  const body2 = '林舟等到了师父。'; draft(project, root, 2, body2); const latest = project.commit(2, 'arc').versionCheckpoint.commit;
  const restoredRoot = join(directory, 'restored-old');
  versions.restore(checkpoint, restoredRoot);
  const restored = new Project(restoredRoot);
  try {
    assert.equal(restored.status().memoryThrough, 1);
    assert.equal(restored.memory().facts[0].object, '城门'); assert.equal(restored.doctor().healthy, true);
    assert.deepEqual(readFileSync(join(restoredRoot, 'manuscript/chapters/0001.md')), Buffer.from(body));
    assert.equal(existsSync(join(restoredRoot, '.env')), false);
    assert.ok(readFileSync(join(restoredRoot, '.specwriter/bin/specwriter.mjs'), 'utf8').includes('/dist/cli.js'));
  } finally { restored.close(); }
  assert.equal(project.status().memoryThrough, 2);
  const oldBundle = join(directory, 'restored-old.bundle'); new BookVersions(restoredRoot).bundle(oldBundle);
  const bundleRepo = join(directory, 'bundle-history.git');
  execFileSync('git', ['clone', '--mirror', oldBundle, bundleRepo], { windowsHide: true, stdio: 'pipe' });
  assert.equal(execFileSync('git', ['--git-dir', bundleRepo, 'rev-parse', `refs/specwriter/source-tips/${latest}`], { encoding: 'utf8' }).trim(), latest);
  assert.throws(() => versions.restore(checkpoint, restoredRoot), /new directory/);
  assert.throws(() => versions.restore(checkpoint, join(root, 'nested')), /outside/);
  const bundle = join(directory, 'book.bundle'); versions.bundle(bundle);
  assert.throws(() => versions.bundle(bundle), /new file/);
  const migrated = join(directory, 'migrated');
  const result = spawnSync(process.execPath, [cli, 'version', 'restore', 'HEAD', '--bundle', bundle, '--to', migrated, '--json'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const next = new Project(migrated); try { assert.equal(next.status().memoryThrough, 2); assert.equal(next.doctor().healthy, true); } finally { next.close(); }
});

test('checkpoint refuses unsynced edits and credentials; backup failure does not roll back chapter acceptance', t => {
  const { root, project } = book(t), versions = new BookVersions(root);
  versions.init(project);
  const body = '林舟来到城门。'; draft(project, root, 1, body); project.commit(1, 'arc');
  writeFileSync(join(root, 'manuscript/chapters/0001.md'), '未经接纳的手动编辑');
  assert.throws(() => versions.save(project), /synchronized/);
  project.sync({ capture: true });
  writeFileSync(join(root, '.env'), 'QWEN_API_KEY=private-credential-fixture\n');
  assert.throws(() => versions.save(project, 'private-credential-fixture'), /configured credential/);
  writeFileSync(join(root, 'manuscript/drafts/private.md'), '误写的密钥 private-credential-fixture');
  const count = versions.log().length;
  draft(project, root, 2, '林舟离开城门。'); const accepted = project.commit(2, 'arc');
  assert.equal(accepted.versionNeedsSave, true); assert.equal(accepted.versionCheckpoint.saved, false);
  assert.equal(project.status().memoryThrough, 2); assert.equal(project.store.history(2).length, 1);
  assert.equal(versions.log().length, count);
  assert.ok(!accepted.versionCheckpoint.warning.includes('private-credential-fixture'));
  writeFileSync(join(root, 'manuscript/drafts/private.md'), '移除误写的密钥');
  assert.equal(versions.save(project, '补存').saved, true);
});

test('restore detects manifest corruption before exposing a target and rejects unsafe revisions', t => {
  const { root, directory, project } = book(t), versions = new BookVersions(root);
  versions.init(project); const repo = join(root, '.specwriter/version/repository.git');
  const call = (args, input) => execFileSync('git', ['--git-dir', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { encoding: 'utf8', input, windowsHide: true }).trim();
  const old = versions.log()[0].commit;
  const manifest = JSON.parse(call(['show', `${old}:.specwriter/backup/manifest.json`]));
  manifest.files[0].hash = '0'.repeat(64);
  const blob = call(['hash-object', '-w', '--stdin'], JSON.stringify(manifest));
  call(['read-tree', `${old}^{tree}`]); call(['update-index', '--cacheinfo', '100644', blob, '.specwriter/backup/manifest.json']);
  const tree = call(['write-tree']); const corrupt = call(['commit-tree', tree, '-p', old], 'corrupted fixture\n');
  const target = join(directory, 'invalid');
  assert.throws(() => versions.restore(corrupt, target), /checksum mismatch/);
  assert.equal(existsSync(target), false);
  assert.throws(() => versions.restore('--upload-pack=bad', target), /commit hash/);
  assert.equal(project.doctor().healthy, true);
});

test('restore CLI works with a corrupt original live database and keeps the source intact', t => {
  const directory = mkdtempSync(join(tmpdir(), 'specwriter-damaged-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'book'); initProject(root, '损坏恢复', { memoryBackend: 'local' });
  const project = new Project(root); project.propose('arc', '开篇', 1, 1); project.sync();
  const versions = new BookVersions(root); versions.init(project);
  draft(project, root, 1, '林舟来到城门。'); project.commit(1, 'arc'); project.close();
  const db = join(root, '.specwriter/memory/writer.db'); writeFileSync(db, 'corrupt live database fixture');
  const target = join(directory, 'recovered');
  const result = spawnSync(process.execPath, [cli, 'version', 'restore', 'HEAD', '--root', root, '--to', target, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(db, 'utf8'), 'corrupt live database fixture');
  const restored = new Project(target); try { assert.equal(restored.status().memoryThrough, 1); assert.equal(restored.doctor().healthy, true); } finally { restored.close(); }
});

test('periodic packing preserves the entire history and book identities cannot be mixed', t => {
  const { root, project } = book(t), other = book(t), versions = new BookVersions(root);
  versions.init(project);
  assert.throws(() => versions.save(other.project), /identity mismatch/);
  for (let i = 1; i < 20; i++) versions.save(project, `检查点 ${i}`);
  const packs = readdirSync(join(root, '.specwriter/version/repository.git/objects/pack'));
  assert.ok(packs.some(name => name.endsWith('.pack')));
  assert.equal(versions.log().length, 20);
  execFileSync('git', ['--git-dir', join(root, '.specwriter/version/repository.git'), 'fsck', '--strict'], { windowsHide: true, stdio: 'pipe' });
  assert.equal(other.project.status().memoryThrough, 0);
  assert.equal(existsSync(join(other.root, '.specwriter/version/repository.git')), false);
});
