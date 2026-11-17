import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetRecord, posixJoin } from '../src/cmake-intake.mjs';

const codemodelRef = {
  jsonFile: 'codemodel-a.json',
  digest: 'a'.repeat(64),
  paths: { source: '/project/source', build: '/project/build' },
};

test('posixJoin 仅做字符串归一化，不触碰磁盘', () => {
  assert.equal(posixJoin('/project/source', 'src/main.c'), '/project/source/src/main.c');
  assert.equal(posixJoin('/project/source', './src/../src/main.c'), '/project/source/src/main.c');
  assert.equal(posixJoin('/project/source/sub', '../main.c'), '/project/source/main.c');
  assert.equal(posixJoin('/project/source', '../../etc/passwd'), '/project/etc/passwd');
  assert.equal(posixJoin('relative/base', 'a/b.c'), 'relative/base/a/b.c');
  assert.equal(posixJoin('/a', '/absolute.c'), '/a/absolute.c');
  assert.equal(posixJoin(null, 'x'), null);
});

test('源码组与编译组越界按下标定位记录为 issue', () => {
  const targetDoc = {
    id: 'lib::b', name: 'lib', type: 'STATIC_LIBRARY',
    paths: { source: '.', build: '.' },
    sources: [
      { path: 'a.c', sourceGroupIndex: 0, compileGroupIndex: 0 },
      { path: 'b.c', sourceGroupIndex: 9, compileGroupIndex: 2 },
    ],
    sourceGroups: [{ name: 'Sources', sourceIndexes: [0, 7] }],
    compileGroups: [{ language: 'C', sourceIndexes: [0] }, { language: 'C', sourceIndexes: [9] }],
  };
  const { record, issues } = buildTargetRecord({
    targetDoc, configuration: 'Debug',
    targetRef: { id: 'lib::b', name: 'lib', jsonFile: 't.json', digest: 'b'.repeat(64) },
    codemodelRef, replyName: 'index-x.json',
  });
  const codes = issues.map(issue => issue.code);
  assert.ok(codes.includes('SOURCE_GROUP_INDEX_OUT_OF_RANGE'));
  assert.ok(codes.includes('COMPILE_GROUP_INDEX_OUT_OF_RANGE'));
  assert.ok(codes.includes('SOURCE_GROUP_MEMBER_OUT_OF_RANGE'));
  assert.ok(codes.includes('COMPILE_GROUP_MEMBER_OUT_OF_RANGE'));
  assert.match(issues.find(issue => issue.code === 'SOURCE_GROUP_INDEX_OUT_OF_RANGE').location,
    /configurations\/Debug\/targets\/lib::b\/sources\/1\/sourceGroupIndex/);
  assert.equal(record.sources[1].sourceGroup, null);
  assert.equal(record.sources[1].compileLanguage, null);
  // 越界成员映射为 null 稳定键，不会静默指向其他源码。
  assert.deepEqual(record.sourceGroups[0].sourceKeys, ['/project/source/a.c', null]);
  assert.deepEqual(record.compileGroups[1].sourceKeys, [null]);
});

test('同 targetId 在不同配置下产出互相独立的记录与组', () => {
  const make = configuration => buildTargetRecord({
    targetDoc: {
      id: 'app::a', name: 'app', type: 'EXECUTABLE', paths: { source: '.', build: '.' },
      sources: [{ path: 'main.c', sourceGroupIndex: 0, compileGroupIndex: 0 }],
      sourceGroups: [{ name: 'Sources', sourceIndexes: [0] }],
      compileGroups: [{ language: 'C', sourceIndexes: [0], compileCommandFragments: [{ fragment: configuration === 'Debug' ? '-DDEBUG' : '-DRELEASE' }] }],
    },
    configuration,
    targetRef: { id: 'app::a', name: 'app', jsonFile: `t-${configuration}.json`, digest: 'c'.repeat(64) },
    codemodelRef, replyName: 'index-x.json',
  });
  const debug = make('Debug');
  const release = make('Release');
  assert.notEqual(debug.record, release.record);
  assert.equal(debug.record.configuration, 'Debug');
  assert.equal(release.record.configuration, 'Release');
  assert.equal(debug.record.targetId, release.record.targetId);
  assert.equal(debug.record.compileGroups[0].fragments[0], '-DDEBUG');
  assert.equal(release.record.compileGroups[0].fragments[0], '-DRELEASE');
  assert.equal(debug.record.evidence.target.jsonFile, 't-Debug.json');
  assert.equal(release.record.evidence.target.jsonFile, 't-Release.json');
});

test('生成路径与未承诺字段如实登记，且稳定键不依赖数组下标', () => {
  const targetDoc = {
    id: 'app::a', name: 'app', type: 'EXECUTABLE', paths: { source: '.', build: '.' },
    sources: [
      { path: 'gen/x.h', isGenerated: true, sourceGroupIndex: 0 },
      { path: 'gen/x.h', isGenerated: true, sourceGroupIndex: 0 },
    ],
    sourceGroups: [{ name: 'Generated', sourceIndexes: [0, 1] }],
    compileGroups: [],
    customExtension: { keep: true },
  };
  const { record, issues } = buildTargetRecord({
    targetDoc, configuration: 'Release',
    targetRef: { id: 'app::a', name: 'app', jsonFile: 't.json', digest: 'd'.repeat(64) },
    codemodelRef, replyName: 'index-x.json',
  });
  assert.equal(record.sources[0].stableKey, '/project/source/gen/x.h');
  assert.equal(record.sources[1].stableKey, '/project/source/gen/x.h#1');
  const generated = issues.filter(issue => issue.code === 'GENERATED_PATH_PRESENCE_UNVERIFIED');
  assert.equal(generated.length, 2);
  const unsupported = issues.find(issue => issue.code === 'UNSUPPORTED_TARGET_FIELD');
  assert.ok(unsupported);
  assert.match(unsupported.location, /customExtension$/);
  assert.deepEqual(record.sourceGroups[0].sourceKeys, ['/project/source/gen/x.h', '/project/source/gen/x.h#1']);
});

test('目标回复 id 不一致与非法文档被识别', () => {
  const { issues } = buildTargetRecord({
    targetDoc: { id: 'other::x', name: 'app' }, configuration: 'Debug',
    targetRef: { id: 'app::a', name: 'app', jsonFile: 't.json', digest: 'e'.repeat(64) },
    codemodelRef, replyName: 'index-x.json',
  });
  assert.ok(issues.some(issue => issue.code === 'TARGET_ID_MISMATCH'));
  const invalid = buildTargetRecord({
    targetDoc: null, configuration: 'Debug',
    targetRef: { id: 'app::a', name: 'app', jsonFile: 't.json', digest: 'f'.repeat(64) },
    codemodelRef, replyName: 'index-x.json',
  });
  assert.equal(invalid.record, null);
  assert.ok(invalid.issues.some(issue => issue.code === 'TARGET_DOC_INVALID'));
});
