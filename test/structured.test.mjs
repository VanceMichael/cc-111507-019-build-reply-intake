import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

async function withService(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-check-'));
  const service = await createService({ dataDir, ...options });
  try {
    return await run(service, dataDir);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function intake(service, body = { mode: 'structured', client: 'client-release' }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('结构化收件：按客户请求定位回复、分配置记录来源与编译组', async () => {
  await withService({}, async (service, dataDir) => {
    const { status, body } = await intake(service);
    assert.equal(status, 201);
    assert.equal(body.state, 'complete');
    assert.equal(body.mode, 'structured');
    assert.equal(body.metadata.client, 'client-release');
    assert.equal(body.metadata.codemodel, 'codemodel-a.json');
    assert.ok(Array.isArray(body.records));
    assert.equal(body.records.length, 2);
    assert.deepEqual(body.records.map(record => record.configuration), ['Debug', 'Release']);
    const [debug, release] = body.records;
    assert.equal(debug.targetId, release.targetId);
    assert.equal(debug.targetId, 'app::a');
    assert.equal(debug.paths.codemodel.source, '/project/source');
    assert.equal(debug.paths.codemodel.build, '/project/build');
    assert.equal(debug.paths.sourceRoot, '/project/source');
    assert.equal(debug.paths.buildRoot, '/project/build');
    assert.deepEqual(debug.sources.map(source => source.path), ['src/main.c', 'generated/debug.h']);
    assert.deepEqual(release.sources.map(source => source.path), ['src/main.c', 'generated/release.h']);
    assert.ok(debug.sources[1].isGenerated);
    assert.equal(debug.sources[1].sourcePath, '/project/source/generated/debug.h');
    assert.equal(debug.sources[1].buildPath, '/project/build/generated/debug.h');
    assert.equal(debug.sources[1].resolvedPath, '/project/build/generated/debug.h',
      '生成文件以 build 基准定位');
    assert.equal(debug.sources[0].resolvedPath, '/project/source/src/main.c',
      '普通源码以 source 基准定位');
    assert.deepEqual(debug.sourceGroups.map(group => group.name), ['Sources', 'Generated']);
    assert.deepEqual(debug.sourceGroups[1].sources, ['/project/build/generated/debug.h']);
    assert.deepEqual(debug.compileGroups.map(group => group.language), ['C']);
    assert.deepEqual(debug.compileGroups[0].sources, ['/project/source/src/main.c']);
    assert.deepEqual(debug.compileGroups[0].compileCommandFragments, [{ fragment: '-DDEBUG' }]);
    assert.deepEqual(release.compileGroups[0].compileCommandFragments, [{ fragment: '-DRELEASE' }]);
    assert.notDeepEqual(debug.sourceGroups, release.sourceGroups);
    assert.notDeepEqual(debug.compileGroups, release.compileGroups);
    assert.equal(debug.provenance.index, 'index-2026-11-15T00-00-00.json');
    assert.equal(debug.provenance.client, 'client-release');
    assert.equal(debug.provenance.codemodel, 'codemodel-a.json');
    assert.equal(debug.provenance.target, 'target-debug.json');
    assert.deepEqual(Object.keys(debug.provenance.digests).sort(), ['codemodel', 'index', 'target']);
    for (const digest of Object.values(debug.provenance.digests)) assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(debug.provenance.sourceVersion, '\"source-v1\"');
    assert.equal(body.issues.length, 0);
    assert.equal(body.coverage.structured, true);
    assert.equal(body.coverage.complete, true);
    assert.equal(body.coverage.objectsIgnored, 1);
    assert.equal(body.coverage.targets.declared, 2);
    assert.equal(body.coverage.targets.collected, 2);
    assert.equal(body.coverage.buildCommandsExecuted, false);
    assert.equal(body.coverage.diskChecked, false);
    assert.ok(body.evidence.some(item => item.role === 'reply-index'));
    assert.ok(body.evidence.some(item => item.role === 'codemodel'));
    assert.ok(body.evidence.some(item => item.role === 'target'));
    assert.ok(!service.gateway.trace.some(item => item.path.includes('stale.json')),
      '不得从 objects 列表或目录中挑选残留对象');
    assert.ok(!service.gateway.trace.some(item => item.path.startsWith('/files/')),
      '结构化收件不应读取原始入口文件');

    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${body.id}`)).json();
    assert.deepEqual(saved.records, body.records);
    assert.deepEqual(saved.coverage, body.coverage);
    assert.deepEqual(saved.issues, body.issues);

    const reopened = await createService({ dataDir });
    try {
      const persisted = await (await fetch(`${reopened.baseUrl}/v1/receipts/${body.id}`)).json();
      assert.deepEqual(persisted.records, body.records);
    } finally {
      await reopened.close();
    }
  });
});

test('结构化收件：缺失目标文件形成可定位的 partial 收件', async () => {
  await withService({ scenario: 'missing-target' }, async (service) => {
    const { body } = await intake(service);
    assert.equal(body.state, 'partial');
    assert.equal(body.coverage.complete, false);
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].configuration, 'Debug');
    assert.equal(body.records[0].provenance.target, 'target-debug.json');
    assert.ok(!body.records.some(record => record.configuration === 'Release'));
    const missing = body.issues.find(item => item.code === 'target-file-missing');
    assert.ok(missing);
    assert.equal(missing.location.configuration, 'Release');
    assert.equal(missing.location.targetId, 'app::a');
    assert.equal(missing.location.jsonFile, 'target-release.json');
    assert.equal(body.coverage.targets.declared, 2);
    assert.equal(body.coverage.targets.collected, 1);
    assert.equal(body.coverage.targets.missingFiles, 1);
  });
});

test('结构化收件：索引更新后不拼接旧回复对象', async () => {
  await withService({ scenario: 'changed-index' }, async (service) => {
    const { body } = await intake(service);
    assert.equal(body.state, 'partial');
    assert.equal(body.coverage.complete, false);
    assert.equal(body.coverage.index, 'index-2026-11-15T00-00-01.json');
    assert.equal(body.metadata.codemodel, 'codemodel-b.json');
    assert.equal(body.coverage.indexChanges, 1);
    assert.ok(body.issues.some(item => item.code === 'index-changed' && item.severity === 'warning'));
    assert.deepEqual(body.records, [], '新索引下没有配置时不得保留旧索引的目标记录');
    assert.ok(service.gateway.trace.some(item => item.path === '/build/reply/codemodel-b.json'));
    const attemptLog = body.coverage.attemptLog;
    assert.equal(attemptLog.length, 2);
    assert.equal(attemptLog[0].codemodel, 'codemodel-a.json');
    assert.equal(attemptLog[0].records, 2);
    assert.equal(attemptLog[1].codemodel, 'codemodel-b.json');
    assert.equal(attemptLog[1].records, 0);
  });
});

test('结构化收件：客户级错误回复如实拒绝且不从 objects 绕过', async () => {
  await withService({ scenario: 'client-error' }, async (service) => {
    const { body } = await intake(service);
    assert.equal(body.state, 'rejected');
    assert.deepEqual(body.records, []);
    const error = body.issues.find(item => item.code === 'client-response-error');
    assert.ok(error);
    assert.equal(error.location.client, 'client-release');
    assert.equal(body.metadata.codemodel, null);
    assert.ok(!service.gateway.trace.some(item => item.path.includes('stale.json')));
  });
});

test('结构化收件：未知客户与不兼容版本不会被随便选一个回复', async () => {
  await withService({}, async (service) => {
    const unknown = await intake(service, { mode: 'structured', client: 'client-absent' });
    assert.equal(unknown.body.state, 'rejected');
    assert.deepEqual(unknown.body.records, []);
    assert.ok(unknown.body.issues.some(item => item.code === 'client-missing'));

    const incompatible = await intake(service, { mode: 'structured', client: 'client-release', version: { major: 3 } });
    assert.equal(incompatible.body.state, 'rejected');
    assert.deepEqual(incompatible.body.records, []);
    assert.ok(incompatible.body.issues.some(item => item.code === 'codemodel-version-incompatible'));

    const beforeInvalid = service.gateway.trace.length;
    const invalid = await intake(service, { mode: 'structured', client: '../escape' });
    assert.equal(invalid.body.state, 'rejected');
    assert.ok(invalid.body.issues.some(item => item.code === 'client-invalid'));
    assert.equal(service.gateway.trace.length, beforeInvalid, '无效客户不应向来源发起请求');
  });
});

test('结构化收件：目标文件与声明不一致时保留记录并标注问题', async () => {
  const { createServer } = await import('node:http');
  const documents = {
    'index.json': {
      reply: {
        'client-release': {
          'query.json': {
            requests: [{ kind: 'codemodel', version: { major: 2 } }],
            responses: [{ kind: 'codemodel', version: { major: 2, minor: 7 }, jsonFile: 'codemodel.json' }],
          },
        },
      },
      objects: [{ kind: 'codemodel', jsonFile: 'stale.json' }],
    },
    'codemodel.json': {
      kind: 'codemodel',
      version: { major: 2, minor: 7 },
      paths: { source: '/src', build: '/build' },
      configurations: [{
        name: 'Debug',
        targets: [{ id: 'app::a', name: 'app', jsonFile: 'target.json' }],
      }],
    },
    'target.json': {
      id: 'app::other',
      name: 'renamed',
      type: 'EXECUTABLE',
      paths: { source: '.', build: '.' },
      sources: [{
        path: 'main.c',
        compileGroupIndex: 0,
        sourceGroupIndex: 0,
        isGenerated: true,
      }],
      sourceGroups: [{ name: 'Sources', sourceIndexes: [0] }],
      compileGroups: [{ language: 'C', sourceIndexes: [0] }],
    },
  };
  const source = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/build/index') {
      response.end(JSON.stringify({ index: 'index.json' }));
      return;
    }
    if (url.pathname.startsWith('/build/reply/')) {
      const name = decodeURIComponent(url.pathname.slice('/build/reply/'.length));
      if (documents[name]) {
        response.end(JSON.stringify(documents[name]));
        return;
      }
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: '不存在' }));
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const sourceBase = `http://127.0.0.1:${source.address().port}`;
  const { ReceiptStore } = await import('../src/store.mjs');
  const { collect } = await import('../src/receiver.mjs');
  const dataDir = await mkdtemp(join(tmpdir(), 'structured-mismatch-'));
  try {
    const store = new ReceiptStore(dataDir);
    await store.open();
    const receipt = await collect({
      input: { mode: 'structured', client: 'client-release' },
      descriptor: { entry: 'unused.json', product: '测试产品' },
      sourceBase,
      store,
    });
    assert.equal(receipt.receipt.state, 'partial');
    assert.equal(receipt.receipt.records.length, 1);
    const record = receipt.receipt.records[0];
    assert.equal(record.targetId, 'app::other');
    assert.equal(record.name, 'renamed');
    assert.equal(record.paths.sourceRoot, '/src');
    assert.equal(record.sources[0].sourcePath, '/src/main.c');
    assert.equal(record.sources[0].buildPath, '/build/main.c');
    assert.equal(record.sources[0].resolvedPath, '/build/main.c');
    assert.ok(record.sources[0].isGenerated);
    const codes = receipt.receipt.issues.map(item => item.code);
    assert.ok(codes.includes('target-id-mismatch'));
    assert.ok(codes.includes('target-name-mismatch'));
    assert.ok(receipt.receipt.evidence.some(item => item.role === 'target' && item.jsonFile === 'target.json'));
  } finally {
    await new Promise(resolve => source.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

