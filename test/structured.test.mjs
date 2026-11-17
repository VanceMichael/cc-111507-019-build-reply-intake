import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

const CLIENT = 'client-release';

async function openIntake(service, body = { mode: 'structured', client: CLIENT }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, result: await response.json() };
}

test('结构化收件：standard 来源记录、可查询性及覆盖身份', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir });
  try {
    const { response, result } = await openIntake(service);
    assert.equal(response.status, 201);
    assert.equal(result.state, 'complete');
    assert.equal(result.records.length, 2);
    const byConfig = Object.fromEntries(result.records.map(record => [record.configuration, record]));
    assert.deepEqual(Object.keys(byConfig).sort(), ['Debug', 'Release']);
    // 同一 targetId 在两个配置下分别成记录，不跨配置合并源码组/编译组。
    for (const configuration of ['Debug', 'Release']) {
      const record = byConfig[configuration];
      assert.equal(record.targetId, 'app::a');
      assert.equal(record.targetName, 'app');
      assert.equal(record.targetType, 'EXECUTABLE');
      assert.equal(record.paths.codemodelSourceRoot, '/project/source');
      assert.equal(record.paths.codemodelBuildRoot, '/project/build');
      assert.equal(record.paths.targetSourceBase, '/project/source');
      // 稳定身份使用解析路径而非数组下标。
      const main = record.sources.find(source => source.path === 'src/main.c');
      assert.equal(main.resolvedPath, '/project/source/src/main.c');
      assert.equal(main.stableKey, '/project/source/src/main.c');
      assert.equal(main.isGenerated, false);
      assert.equal(main.sourceGroup, 'Sources');
      assert.equal(main.compileLanguage, 'C');
      const generated = record.sources.find(source => source.isGenerated);
      assert.equal(generated.resolvedPath,
        configuration === 'Debug' ? '/project/source/generated/debug.h' : '/project/source/generated/release.h');
      assert.equal(record.sourceGroups.length, 2);
      assert.equal(record.sourceGroups[0].name, 'Sources');
      assert.deepEqual(record.sourceGroups[0].sourceKeys, ['/project/source/src/main.c']);
      assert.equal(record.compileGroups.length, 1);
      assert.equal(record.compileGroups[0].language, 'C');
      assert.deepEqual(record.compileGroups[0].fragments,
        [configuration === 'Debug' ? '-DDEBUG' : '-DRELEASE']);
      assert.deepEqual(record.compileGroups[0].sourceKeys, ['/project/source/src/main.c']);
      // 生成路径尚未出现须如实记录，且未触碰磁盘、未运行构建。
      assert.ok(result.issues.some(issue => issue.code === 'GENERATED_PATH_PRESENCE_UNVERIFIED'
        && issue.location.includes(configuration)));
      assert.equal(record.evidence.replyIndex, 'index-2026-11-15T00-00-00.json');
      assert.ok(record.evidence.target.jsonFile.endsWith('.json'));
      assert.match(record.evidence.target.digest, /^[0-9a-f]{64}$/);
    }
    // 不得读取索引 objects 残留，也不得读取更新后索引才引用的新 codemodel。
    const fetched = service.gateway.trace.map(item => item.path);
    assert.ok(!fetched.includes('/build/reply/stale.json'));
    assert.ok(!fetched.includes('/build/reply/codemodel-b.json'));
    assert.ok(fetched.includes('/build/reply/codemodel-a.json'));
    assert.ok(fetched.includes('/build/reply/target-debug.json'));
    assert.ok(fetched.includes('/build/reply/target-release.json'));
    // 所有来源字节均有证据与 SHA-256 摘要。
    assert.equal(result.blobs.length, 4);
    for (const blob of result.blobs) assert.match(blob.digest, /^[0-9a-f]{64}$/);
    assert.equal(result.coverage.index.drifted, false);
    assert.equal(result.coverage.issueCounts.error, 0);
    // 接收后查询返回相同记录；新实例打开相同 DATA_DIR 仍可查询。
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
    assert.deepEqual(saved.coverage, result.coverage);
    await service.close();
    const reopened = await createService({ dataDir });
    try {
      const persisted = await (await fetch(`${reopened.baseUrl}/v1/receipts/${result.id}`)).json();
      assert.deepEqual(persisted.records, result.records);
      assert.equal(persisted.state, 'complete');
    } finally { await reopened.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：missing-target 形成 partial 且缺失被定位记录', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-missing-'));
  const service = await createService({ dataDir, scenario: 'missing-target' });
  try {
    const { response, result } = await openIntake(service);
    assert.equal(response.status, 201);
    assert.equal(result.state, 'partial');
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].configuration, 'Debug');
    const missing = result.issues.filter(issue => issue.code === 'SOURCE_REFERENCE_MISSING');
    assert.equal(missing.length, 1);
    assert.match(missing[0].location, /configurations\/1\/targets/);
    assert.equal(missing[0].detail.name, 'target-release.json');
    assert.equal(missing[0].detail.status, 404);
    assert.equal(result.coverage.configurations[1].missingTargets, 1);
    assert.equal(result.coverage.complete, false);
    // 缺失对象不得用残留文件拼补。
    assert.ok(!service.gateway.trace.some(item => item.path === '/build/reply/stale.json'));
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${result.id}`)).json();
    assert.deepEqual(saved.records, result.records);
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：client-error 客户级错误形成 rejected', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-client-error-'));
  const service = await createService({ dataDir, scenario: 'client-error' });
  try {
    const { response, result } = await openIntake(service);
    assert.equal(response.status, 201);
    assert.equal(result.state, 'rejected');
    assert.deepEqual(result.records, []);
    const error = result.issues.find(issue => issue.code === 'CLIENT_REPLY_ERROR');
    assert.ok(error);
    assert.equal(error.detail.error, '请求版本不支持');
    // 不能从 objects 列表绕过客户级 error。
    assert.ok(!service.gateway.trace.some(item => item.path === '/build/reply/stale.json'));
    // 索引原文仍作为证据保留。
    assert.equal(result.evidence.resources[0].role, 'index-pointer');
    assert.ok(result.blobs.some(blob => blob.name === 'index-2026-11-15T00-00-00.json'));
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：changed-index 记录索引漂移且不采用残留或新对象', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-drift-'));
  const service = await createService({ dataDir, scenario: 'changed-index' });
  try {
    const { response, result } = await openIntake(service);
    assert.equal(response.status, 201);
    assert.equal(result.records.length, 2);
    const drift = result.issues.find(issue => issue.code === 'REPLY_INDEX_DRIFTED');
    assert.ok(drift);
    assert.equal(drift.detail.pinnedIndex, 'index-2026-11-15T00-00-00.json');
    assert.equal(drift.detail.currentIndex, 'index-2026-11-15T00-00-01.json');
    assert.equal(result.coverage.index.pinned, 'index-2026-11-15T00-00-00.json');
    assert.equal(result.coverage.index.current, 'index-2026-11-15T00-00-01.json');
    assert.equal(result.coverage.index.drifted, true);
    // 漂移只产生 warning，已锁定回复内的两配置记录仍然完整可用。
    assert.equal(result.coverage.issueCounts.error, 0);
    assert.ok(!service.gateway.trace.some(item => item.path === '/build/reply/codemodel-b.json'));
    assert.ok(!service.gateway.trace.some(item => item.path === '/build/reply/stale.json'));
    // 记录证据仍指向领取时锁定的旧不可变回复。
    for (const record of result.records) assert.equal(record.evidence.replyIndex, 'index-2026-11-15T00-00-00.json');
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：未知客户不得借助 objects 残留拼出结果', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-unknown-client-'));
  const service = await createService({ dataDir });
  try {
    const { response, result } = await openIntake(service, { mode: 'structured', client: 'client-other' });
    assert.equal(response.status, 201);
    assert.equal(result.state, 'rejected');
    assert.ok(result.issues.some(issue => issue.code === 'CLIENT_REPLY_MISSING'));
    assert.ok(!service.gateway.trace.some(item => item.path === '/build/reply/stale.json'));
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('结构化收件：缺少或非法 client 返回 400', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-bad-client-'));
  const service = await createService({ dataDir });
  try {
    for (const body of [{ mode: 'structured' }, { mode: 'structured', client: '' }, { mode: 'structured', client: '../x' }]) {
      const response = await fetch(`${service.baseUrl}/v1/intakes`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.match(payload.error, /client/);
    }
  } finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
});
