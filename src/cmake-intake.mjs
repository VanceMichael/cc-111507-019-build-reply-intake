import { receiveResource } from './http-client.mjs';

// CMake File API codemodel v2：仅承诺本文件列出的字段范围；其余扩展保留原文并登记不支持。
const CODEMODEL_KIND = 'codemodel';
const SUPPORTED_MAJOR = 2;
const QUERY_FILE = 'query.json';
const KNOWN_TARGET_FIELDS = new Set(['id', 'name', 'type', 'paths', 'sources', 'sourceGroups', 'compileGroups',
  'dependencies', 'install', 'archive', 'link', 'framework']);
const KNOWN_CODEMODEL_FIELDS = new Set(['kind', 'version', 'paths', 'configurations']);
const KNOWN_CONFIG_FIELDS = new Set(['name', 'targets', 'directories', 'projects', 'nameOnDisk']);
const SAFE_REPLY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;

function makeIssue(severity, code, message, location, detail) {
  const item = { severity, code, message, location };
  if (detail !== undefined) item.detail = detail;
  return item;
}

function countIssues(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of issues) counts[item.severity] = (counts[item.severity] || 0) + 1;
  return counts;
}

// CMake File API 路径按正斜杠表达；仅做字符串归一化，不触碰磁盘，isGenerated 不要求当前存在。
export function posixJoin(base, relative) {
  if (typeof base !== 'string' || typeof relative !== 'string') return null;
  const absolute = base.startsWith('/');
  const stack = [];
  for (const part of base.split('/')) {
    if (!part.length || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  for (const part of relative.split('/')) {
    if (!part.length || part === '.') continue;
    if (part === '..') { if (stack.length > 1) stack.pop(); }
    else stack.push(part);
  }
  return (absolute ? '/' : '') + stack.join('/');
}

function safeReplyName(name) {
  return typeof name === 'string' && SAFE_REPLY_NAME.test(name) && !name.includes('//');
}

function unknownFields(doc, known) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  return Object.keys(doc).filter(key => !known.has(key));
}

// 纯解析：由单个 target 回复构建一条配置内目标记录；不发起任何网络访问。
export function buildTargetRecord({ targetDoc, configuration, targetRef, codemodelRef, replyName }) {
  const issues = [];
  const baseLocation = `configurations/${configuration}/targets/${targetRef.id}`;
  if (!targetDoc || typeof targetDoc !== 'object' || Array.isArray(targetDoc)) {
    return { record: null, issues: [makeIssue('error', 'TARGET_DOC_INVALID', '目标回复不是 JSON 对象', baseLocation)] };
  }
  const targetId = typeof targetDoc.id === 'string' ? targetDoc.id : String(targetRef.id);
  if (targetDoc.id !== targetRef.id) {
    issues.push(makeIssue('error', 'TARGET_ID_MISMATCH', '目标回复内 id 与 codemodel 引用不一致',
      baseLocation, { referencedId: targetRef.id, replyId: targetDoc.id ?? null }));
  }
  const codemodelPaths = codemodelRef.paths || {};
  const targetPaths = targetDoc.paths || {};
  const sourceBase = posixJoin(codemodelPaths.source ?? '', targetPaths.source ?? '.') ?? codemodelPaths.source ?? '';
  const buildBase = posixJoin(codemodelPaths.build ?? '', targetPaths.build ?? '.') ?? codemodelPaths.build ?? '';

  const sources = Array.isArray(targetDoc.sources) ? targetDoc.sources : [];
  const sourceGroups = Array.isArray(targetDoc.sourceGroups) ? targetDoc.sourceGroups : [];
  const compileGroups = Array.isArray(targetDoc.compileGroups) ? targetDoc.compileGroups : [];
  if (!Array.isArray(targetDoc.sources) && targetDoc.sources !== undefined)
    issues.push(makeIssue('error', 'SOURCES_INVALID', 'sources 不是数组', `${baseLocation}/sources`));
  if (!Array.isArray(targetDoc.sourceGroups) && targetDoc.sourceGroups !== undefined)
    issues.push(makeIssue('error', 'SOURCE_GROUPS_INVALID', 'sourceGroups 不是数组', `${baseLocation}/sourceGroups`));
  if (!Array.isArray(targetDoc.compileGroups) && targetDoc.compileGroups !== undefined)
    issues.push(makeIssue('error', 'COMPILE_GROUPS_INVALID', 'compileGroups 不是数组', `${baseLocation}/compileGroups`));

  // 稳定身份用解析后的路径，不使用数组下标；同路径重复时附加区分后缀。
  const sourceRecords = [];
  const usedKeys = new Map();
  sources.forEach((source, index) => {
    const loc = `${baseLocation}/sources/${index}`;
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.path !== 'string') {
      issues.push(makeIssue('error', 'SOURCE_INVALID', '源码条目缺少字符串 path', loc));
      return;
    }
    const resolvedPath = posixJoin(sourceBase, source.path);
    let stableKey = resolvedPath;
    const seen = usedKeys.get(stableKey) || 0;
    usedKeys.set(stableKey, seen + 1);
    if (seen > 0) stableKey = `${resolvedPath}#${seen}`;
    const isGenerated = source.isGenerated === true;
    let groupName = null;
    if (source.sourceGroupIndex !== undefined) {
      const group = sourceGroups[source.sourceGroupIndex];
      if (!group || typeof group !== 'object') {
        issues.push(makeIssue('error', 'SOURCE_GROUP_INDEX_OUT_OF_RANGE', 'sourceGroupIndex 越界',
          `${loc}/sourceGroupIndex`, { index: source.sourceGroupIndex, groupCount: sourceGroups.length }));
      } else groupName = typeof group.name === 'string' ? group.name : null;
    }
    let compileLanguage = null;
    if (source.compileGroupIndex !== undefined) {
      const group = compileGroups[source.compileGroupIndex];
      if (!group || typeof group !== 'object') {
        issues.push(makeIssue('error', 'COMPILE_GROUP_INDEX_OUT_OF_RANGE', 'compileGroupIndex 越界',
          `${loc}/compileGroupIndex`, { index: source.compileGroupIndex, groupCount: compileGroups.length }));
      } else compileLanguage = typeof group.language === 'string' ? group.language : null;
    }
    if (isGenerated) {
      issues.push(makeIssue('info', 'GENERATED_PATH_PRESENCE_UNVERIFIED',
        '生成路径未在来源端生成，本服务不执行构建，存在性未验证', loc, { resolvedPath }));
    }
    sourceRecords.push({ stableKey, path: source.path, resolvedPath, isGenerated,
      sourceGroupIndex: source.sourceGroupIndex ?? null, sourceGroup: groupName,
      compileGroupIndex: source.compileGroupIndex ?? null, compileLanguage });
  });

  const keyOf = index => sourceRecords[index]?.stableKey ?? null;
  const sourceGroupRecords = sourceGroups.map((group, index) => {
    const loc = `${baseLocation}/sourceGroups/${index}`;
    const indexes = Array.isArray(group?.sourceIndexes) ? group.sourceIndexes : [];
    if (!group || typeof group !== 'object') {
      issues.push(makeIssue('error', 'SOURCE_GROUP_INVALID', '源码组不是对象', loc));
      return { name: null, sourceIndexes: [], sourceKeys: [] };
    }
    for (const sourceIndex of indexes) {
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sourceRecords.length) {
        issues.push(makeIssue('error', 'SOURCE_GROUP_MEMBER_OUT_OF_RANGE', '源码组 sourceIndexes 越界',
          `${loc}/sourceIndexes`, { index: sourceIndex, sourceCount: sourceRecords.length }));
      }
    }
    return { name: typeof group.name === 'string' ? group.name : null, sourceIndexes: indexes,
      sourceKeys: indexes.map(keyOf) };
  });

  const compileGroupRecords = compileGroups.map((group, index) => {
    const loc = `${baseLocation}/compileGroups/${index}`;
    if (!group || typeof group !== 'object') {
      issues.push(makeIssue('error', 'COMPILE_GROUP_INVALID', '编译组不是对象', loc));
      return { language: null, sourceIndexes: [], sourceKeys: [], fragments: [] };
    }
    const indexes = Array.isArray(group.sourceIndexes) ? group.sourceIndexes : [];
    for (const sourceIndex of indexes) {
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sourceRecords.length) {
        issues.push(makeIssue('error', 'COMPILE_GROUP_MEMBER_OUT_OF_RANGE', '编译组 sourceIndexes 越界',
          `${loc}/sourceIndexes`, { index: sourceIndex, sourceCount: sourceRecords.length }));
      }
    }
    const fragments = Array.isArray(group.compileCommandFragments)
      ? group.compileCommandFragments.map(fragment => (fragment && typeof fragment.fragment === 'string' ? fragment.fragment : null))
      : [];
    return { language: typeof group.language === 'string' ? group.language : null, sourceIndexes: indexes,
      sourceKeys: indexes.map(keyOf), fragments };
  });

  for (const field of unknownFields(targetDoc, KNOWN_TARGET_FIELDS)) {
    issues.push(makeIssue('info', 'UNSUPPORTED_TARGET_FIELD', '目标回复含本服务未承诺解析的字段，原文已随证据保留',
      `${baseLocation}/${field}`));
  }

  const record = {
    configuration,
    targetId,
    targetName: typeof targetDoc.name === 'string' ? targetDoc.name : targetRef.name,
    targetType: typeof targetDoc.type === 'string' ? targetDoc.type : null,
    paths: {
      codemodelSourceRoot: codemodelPaths.source ?? null,
      codemodelBuildRoot: codemodelPaths.build ?? null,
      targetSourceBase: sourceBase,
      targetBuildBase: buildBase,
    },
    sources: sourceRecords,
    sourceGroups: sourceGroupRecords,
    compileGroups: compileGroupRecords,
    evidence: {
      replyIndex: replyName,
      codemodel: { jsonFile: codemodelRef.jsonFile, digest: codemodelRef.digest },
      target: { jsonFile: targetRef.jsonFile, digest: targetRef.digest },
    },
  };
  return { record, issues };
}

async function fetchJsonResource(sourceBase, name, role, store, issues, location, blobs, resources) {
  if (!safeReplyName(name)) {
    issues.push(makeIssue('error', 'REPLY_NAME_INVALID', '回复文件名不安全或不是单段文件名', location, { name: String(name) }));
    return null;
  }
  const url = `${sourceBase}/build/reply/${encodeURIComponent(name)}`;
  const result = await receiveResource(url);
  resources.push({ role, name, url, status: result.status, digest: result.digest, bytes: result.bytes.length, etag: result.etag });
  if (!result.ok) {
    issues.push(makeIssue('error', 'SOURCE_REFERENCE_MISSING', '来源引用的回复对象缺失或不可读', location,
      { name, status: result.status }));
    return null;
  }
  const blob = await store.blob(result.bytes);
  blobs.push({ role, name, digest: blob.digest, bytes: blob.bytes });
  let doc;
  try { doc = JSON.parse(result.bytes.toString('utf8')); }
  catch (error) {
    issues.push(makeIssue('error', 'REPLY_JSON_INVALID', '回复不是合法 JSON', location, { name, detail: error.message }));
    return null;
  }
  return { doc, digest: result.digest, etag: result.etag, bytes: result.bytes.length };
}

export async function collectStructured({ input, descriptor, sourceBase, store }) {
  const client = input.client;
  const issues = [];
  const blobs = [];
  const resources = [];
  const records = [];
  const downloadedBytes = () => resources.reduce((sum, item) => sum + (item.bytes || 0), 0);

  // 早退：保留已领取原文与全部已登记 issue，形成 rejected 收件而不是抛异常丢弃。
  const reject = async (extraIssues = []) => {
    issues.push(...extraIssues);
    const counts = countIssues(issues);
    const receipt = await store.save({
      state: 'rejected', mode: 'structured', product: descriptor.product, source: descriptor.entry,
      sourceVersion: null, records: [], issues,
      coverage: { structured: true, client, complete: false, recordCount: 0,
        issueCounts: counts, downloadedBytes: downloadedBytes() },
      evidence: { client, query: QUERY_FILE, index: null, resources }, blobs,
    });
    return { receipt };
  };

  // 第一步：向来源入口询问当前索引名称，绝不扫描 reply 目录或按时间挑 JSON。
  const pointer = await receiveResource(`${sourceBase}/build/index`);
  resources.push({ role: 'index-pointer', name: '/build/index', url: `${sourceBase}/build/index`,
    status: pointer.status, digest: pointer.digest, bytes: pointer.bytes.length, etag: pointer.etag });
  if (!pointer.ok) {
    return reject([makeIssue('error', 'INDEX_POINTER_UNAVAILABLE', '无法获取来源当前回复索引名称',
      '/build/index', { status: pointer.status })]);
  }
  let pointerDoc;
  try { pointerDoc = JSON.parse(pointer.bytes.toString('utf8')); }
  catch (error) {
    return reject([makeIssue('error', 'INDEX_POINTER_INVALID', '来源索引入口不是合法 JSON',
      '/build/index', { detail: error.message })]);
  }
  const indexName = pointerDoc?.index;
  if (typeof indexName !== 'string' || !safeReplyName(indexName)) {
    return reject([makeIssue('error', 'INDEX_NAME_INVALID', '来源索引入口未给出可用的回复文件名',
      '/build/index', { index: indexName ?? null })]);
  }

  // 第二步：按客户自己的 query.json 回复定位 codemodel；objects 列表可能残留旧对象，一律不读。
  const index = await fetchJsonResource(sourceBase, indexName, 'index', store, issues,
    `/build/reply/${indexName}`, blobs, resources);
  if (!index) return reject();
  const indexDoc = index.doc;
  const clientReply = indexDoc?.reply?.[client]?.[QUERY_FILE];
  if (!clientReply || typeof clientReply !== 'object') {
    return reject([makeIssue('error', 'CLIENT_REPLY_MISSING',
      '索引中找不到本客户 query.json 的回复，不能改用 objects 残留对象拼接',
      `reply/${client}/${QUERY_FILE}`)]);
  }
  const responses = Array.isArray(clientReply.responses) ? clientReply.responses : [];
  // 客户级 error 必须原样上浮，不能从 objects 列表绕过。
  const clientError = responses.find(item => item && typeof item === 'object' && item.error);
  if (clientError) {
    return reject([makeIssue('error', 'CLIENT_REPLY_ERROR', '客户回复包含来源级错误',
      `reply/${client}/${QUERY_FILE}/responses`, { error: clientError.error })]);
  }
  const codemodelResponse = responses.find(item => item?.kind === CODEMODEL_KIND && item?.version?.major === SUPPORTED_MAJOR);
  if (!codemodelResponse) {
    const unsupported = responses.filter(item => item?.kind).map(item => ({ kind: item.kind, version: item.version ?? null }));
    return reject([makeIssue('error', 'CODEMODEL_RESPONSE_MISSING',
      '客户回复中没有受支持的 codemodel v2 响应',
      `reply/${client}/${QUERY_FILE}/responses`, { responses: unsupported })]);
  }
  if (typeof codemodelResponse.jsonFile !== 'string') {
    return reject([makeIssue('error', 'CODEMODEL_REFERENCE_INVALID', 'codemodel 响应缺少 jsonFile',
      `reply/${client}/${QUERY_FILE}/responses`)]);
  }

  // 第三步：读取 codemodel（jsonFile 相对 reply 目录）。
  const codemodelName = codemodelResponse.jsonFile;
  const codemodel = await fetchJsonResource(sourceBase, codemodelName, 'codemodel', store, issues,
    `reply/${client}/${QUERY_FILE}/responses/jsonFile`, blobs, resources);
  if (!codemodel) return reject();
  const codemodelDoc = codemodel.doc;
  if (codemodelDoc?.kind !== CODEMODEL_KIND || codemodelDoc?.version?.major !== SUPPORTED_MAJOR) {
    return reject([makeIssue('error', 'CODEMODEL_DOC_INVALID', 'codemodel 回复类型或主版本不受支持',
      `/build/reply/${codemodelName}`, { kind: codemodelDoc?.kind ?? null, version: codemodelDoc?.version ?? null })]);
  }
  for (const field of unknownFields(codemodelDoc, KNOWN_CODEMODEL_FIELDS)) {
    issues.push(makeIssue('info', 'UNSUPPORTED_CODEMODEL_FIELD',
      'codemodel 含未承诺解析的顶层字段，原文已随证据保留', `/build/reply/${codemodelName}/${field}`));
  }

  // 第四步：逐配置、逐目标读取；同一 targetId 在不同配置下保持独立记录，源码组与编译组不跨配置合并。
  const configurationsCoverage = [];
  const configurations = Array.isArray(codemodelDoc.configurations) ? codemodelDoc.configurations : [];
  if (!Array.isArray(codemodelDoc.configurations))
    issues.push(makeIssue('error', 'CODEMODEL_CONFIGURATIONS_INVALID', 'codemodel configurations 不是数组',
      `/build/reply/${codemodelName}/configurations`));
  for (const [configIndex, configuration] of configurations.entries()) {
    const configName = configuration?.name;
    const configLoc = `/build/reply/${codemodelName}/configurations/${configIndex}`;
    if (!configuration || typeof configuration !== 'object' || typeof configName !== 'string') {
      issues.push(makeIssue('error', 'CONFIGURATION_INVALID', '配置条目缺少字符串 name', configLoc));
      configurationsCoverage.push({ name: configName ?? null, targetCount: 0, targetRefs: 0, missingTargets: 0 });
      continue;
    }
    for (const field of unknownFields(configuration, KNOWN_CONFIG_FIELDS)) {
      issues.push(makeIssue('info', 'UNSUPPORTED_CONFIGURATION_FIELD',
        '配置含未承诺解析的字段，原文已随证据保留', `${configLoc}/${field}`));
    }
    const targetRefs = Array.isArray(configuration.targets) ? configuration.targets : [];
    let missing = 0;
    for (const targetRef of targetRefs) {
      const targetLoc = `${configLoc}/targets/${targetRef?.id ?? 'unknown'}`;
      if (!targetRef || typeof targetRef !== 'object' || typeof targetRef.jsonFile !== 'string') {
        issues.push(makeIssue('error', 'TARGET_REFERENCE_INVALID', 'codemodel 目标引用缺少 jsonFile', targetLoc));
        missing += 1;
        continue;
      }
      const target = await fetchJsonResource(sourceBase, targetRef.jsonFile, `target:${configName}`, store, issues,
        targetLoc, blobs, resources);
      if (!target) { missing += 1; continue; }
      const { record, issues: targetIssues } = buildTargetRecord({
        targetDoc: target.doc, configuration: configName,
        targetRef: { ...targetRef, digest: target.digest },
        codemodelRef: { jsonFile: codemodelName, digest: codemodel.digest, paths: codemodelDoc.paths || {} },
        replyName: indexName,
      });
      issues.push(...targetIssues);
      if (record) records.push(record);
    }
    configurationsCoverage.push({ name: configName, targetCount: targetRefs.length - missing,
      targetRefs: targetRefs.length, missingTargets: missing });
  }

  // 第五步：回复索引可能在领取期间更新；重新询问入口并如实记录漂移，残留旧对象不会被用来补齐数据。
  let drifted = false;
  const recheck = await receiveResource(`${sourceBase}/build/index`);
  resources.push({ role: 'index-pointer-recheck', name: '/build/index', url: `${sourceBase}/build/index`,
    status: recheck.status, digest: recheck.digest, bytes: recheck.bytes.length, etag: recheck.etag });
  let currentName = null;
  if (recheck.ok) {
    try { currentName = JSON.parse(recheck.bytes.toString('utf8'))?.index ?? null; } catch { currentName = null; }
  }
  if (currentName === null || currentName !== indexName) {
    drifted = true;
    issues.push(makeIssue('warning', 'REPLY_INDEX_DRIFTED',
      '领取期间来源回复索引已更新；本收件仅基于领取时锁定的不可变回复，未读取目录残留对象',
      '/build/index', { pinnedIndex: indexName, currentIndex: currentName }));
  }

  const counts = countIssues(issues);
  const state = counts.error > 0 ? 'partial' : 'complete';
  const receipt = await store.save({
    state, mode: 'structured', product: descriptor.product, source: descriptor.entry,
    sourceVersion: index.etag || null, records, issues,
    coverage: {
      structured: true, client, kind: CODEMODEL_KIND,
      apiVersion: { major: SUPPORTED_MAJOR, minor: codemodelResponse.version?.minor ?? null },
      index: { pinned: indexName, current: currentName, drifted },
      configurations: configurationsCoverage,
      recordCount: records.length,
      generatedPathsNotVerified: issues.filter(item => item.code === 'GENERATED_PATH_PRESENCE_UNVERIFIED').length,
      issueCounts: counts, downloadedBytes: downloadedBytes(), complete: state === 'complete',
    },
    evidence: {
      client, query: QUERY_FILE,
      index: { name: indexName, digest: index.digest, etag: index.etag },
      resources,
    },
    blobs,
  });
  return { receipt };
}
