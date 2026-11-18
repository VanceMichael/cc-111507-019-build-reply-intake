import { posix } from 'node:path';
import { receiveBytes } from './http-client.mjs';

const DEFAULT_CLIENT = 'client-release';
const SUPPORTED_MAJOR = 2;
const MAX_ATTEMPTS = 3;

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString()); } catch { return null; }
}

function isSafeReference(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 1024
    && !name.includes('\\')
    && !name.includes('\u0000')
    && !name.startsWith('/')
    && !/[\u0000-\u001f]/.test(name)
    && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function isSafeClient(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name);
}

function issue(code, message, location = {}, severity = 'error') {
  return { code, severity, message, location };
}

function resolvePath(base, value) {
  if (typeof base !== 'string' || base.length === 0 || typeof value !== 'string' || value.length === 0) return null;
  return posix.isAbsolute(value) ? posix.normalize(value) : posix.normalize(posix.join(base, value));
}

function versionOf(value) {
  if (!value || typeof value !== 'object') return null;
  const major = Number(value.major);
  if (!Number.isInteger(major)) return null;
  const minor = Number.isInteger(Number(value.minor)) ? Number(value.minor) : 0;
  return { major, minor };
}

function normalizeWantedVersion(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'string') {
    const major = Number(value);
    return Number.isInteger(major) ? { major, minor: 0 } : null;
  }
  return versionOf(value);
}

function versionCompatible(request, response, wanted) {
  const requested = versionOf(request?.version);
  const replied = versionOf(response?.version);
  if (requested && replied && requested.major !== replied.major) return false;
  if (requested && replied && replied.minor < requested.minor) return false;
  if (wanted) {
    if (replied && replied.major !== wanted.major) return false;
    if (replied && replied.minor < wanted.minor) return false;
  }
  return true;
}

function uniqueBlobs(blobs) {
  const seen = new Set();
  const result = [];
  for (const blob of blobs) {
    if (!blob || seen.has(blob.digest)) continue;
    seen.add(blob.digest);
    result.push(blob);
  }
  return result;
}

async function fetchDocument(baseUrl, reference, store, tracker, role, location) {
  try {
    const received = await receiveBytes(`${baseUrl}/build/reply/${encodeURIComponent(reference)}`);
    const blob = await store.blob(received.bytes);
    tracker.blobs.push(blob);
    tracker.downloadedBytes += received.bytes.length;
    tracker.evidence.push({
      role, location: `/build/reply/${reference}`, jsonFile: reference,
      digest: received.digest, bytes: received.bytes.length, etag: received.etag ?? null,
      ...location,
    });
    return { reference, bytes: received.bytes, digest: received.digest, etag: received.etag ?? null, blob };
  } catch (error) {
    return { reference, error: error.message };
  }
}

async function readIndexPointer(baseUrl, store, tracker, location = {}) {
  try {
    const received = await receiveBytes(`${baseUrl}/build/index`);
    const blob = await store.blob(received.bytes);
    const pointer = parseJson(received.bytes);
    if (!pointer || !isSafeReference(pointer.index)) {
      tracker.blobs.push(blob);
      tracker.downloadedBytes += received.bytes.length;
      return { error: '索引入口未返回有效索引名称', digest: received.digest, etag: received.etag ?? null, bytes: received.bytes.length };
    }
    tracker.blobs.push(blob);
    tracker.downloadedBytes += received.bytes.length;
    tracker.evidence.push({
      role: 'index-pointer', location: '/build/index', name: pointer.index,
      digest: received.digest, bytes: received.bytes.length, etag: received.etag ?? null, ...location,
    });
    return {
      name: pointer.index, digest: received.digest, etag: received.etag ?? null,
      bytes: received.bytes.length, blob,
    };
  } catch (error) {
    return { error: `索引入口读取失败：${error.message}` };
  }
}

function locateCodemodel(index, client, wanted) {
  const clients = index?.reply;
  if (!clients || typeof clients !== 'object') {
    return { fatal: issue('index-invalid', '回复索引缺少 reply 客户映射') };
  }
  const query = clients[client]?.['query.json'];
  if (!query || typeof query !== 'object') {
    return { fatal: issue('client-missing', `回复索引中没有客户 ${client} 的 query.json`, { client }) };
  }
  if (query.error) {
    return { fatal: issue('client-response-error', `客户 ${client} 的请求返回错误：${String(query.error)}`, { client }) };
  }
  const requests = Array.isArray(query.requests) ? query.requests : [];
  const responses = Array.isArray(query.responses) ? query.responses : [];
  const errors = [];
  const candidates = [];
  responses.forEach((response, responseIndex) => {
    const location = { client, responseIndex };
    if (!response || typeof response !== 'object') {
      errors.push(issue('client-response-invalid', `客户 ${client} 的第 ${responseIndex} 个回复不是对象`, location));
      return;
    }
    if (response.error) {
      errors.push(issue('client-response-error', `客户 ${client} 的 codemodel 回复错误：${String(response.error)}`, location));
      return;
    }
    if (response.kind !== 'codemodel') return;
    const request = requests[responseIndex];
    if (request && request.kind && request.kind !== 'codemodel') return;
    if (!isSafeReference(response.jsonFile)) {
      errors.push(issue('codemodel-reference-invalid', `客户 ${client} 的 codemodel 回复缺少可用的 jsonFile`, { ...location, jsonFile: response.jsonFile ?? null }));
      return;
    }
    if (!versionCompatible(request, response, wanted)) {
      errors.push(issue('codemodel-version-incompatible', '客户请求的 codemodel 版本与回复不兼容', {
        ...location, requestVersion: request?.version ?? null, responseVersion: response.version ?? null,
      }));
      return;
    }
    candidates.push({ request: request ?? null, response, responseIndex });
  });
  if (candidates.length === 0) {
    if (errors.length > 0) return { fatal: errors[0], issues: errors.slice(1) };
    return { fatal: issue('codemodel-response-missing', `客户 ${client} 的 query.json 没有 codemodel 回复`, { client }) };
  }
  if (candidates.length > 1) {
    return {
      fatal: issue('codemodel-response-ambiguous',
        `客户 ${client} 的 query.json 含多个可用的 codemodel 回复，未做任意选择`,
        { client, responseIndexes: candidates.map(item => item.responseIndex) }),
      issues: errors,
    };
  }
  return { candidate: candidates[0], issues: errors };
}

function resolveRoots(codemodel, target, issues, location) {
  const codemodelSource = typeof codemodel.paths?.source === 'string' ? codemodel.paths.source : null;
  const codemodelBuild = typeof codemodel.paths?.build === 'string' ? codemodel.paths.build : null;
  if (!codemodel.paths || typeof codemodel.paths !== 'object') {
    issues.push(issue('codemodel-paths-missing', 'codemodel 缺少 paths，源码与生成路径无法定位到基准目录', location));
  }
  const targetSource = typeof target.paths?.source === 'string' ? target.paths.source : null;
  const targetBuild = typeof target.paths?.build === 'string' ? target.paths.build : null;
  const sourceRoot = codemodelSource === null ? null : resolvePath(codemodelSource, targetSource ?? '.');
  const buildRoot = codemodelBuild === null ? null : resolvePath(codemodelBuild, targetBuild ?? '.');
  return {
    paths: {
      codemodel: { source: codemodelSource, build: codemodelBuild },
      target: { source: targetSource, build: targetBuild },
      sourceRoot,
      buildRoot,
    },
    sourceRoot,
    buildRoot,
  };
}

function buildSources(target, sourceRoot, buildRoot, issues, location) {
  const rawSources = Array.isArray(target.sources) ? target.sources : [];
  return rawSources.map((source, sourceIndex) => {
    const sourceLocation = { ...location, sourceIndex };
    const path = typeof source?.path === 'string' && source.path.length > 0 ? source.path : null;
    if (path === null) {
      issues.push(issue('source-path-invalid', `配置 ${location.configuration} 的目标 ${location.targetId} 第 ${sourceIndex} 个源码缺少路径`, sourceLocation));
    }
    const isGenerated = source?.isGenerated === true;
    const sourcePath = path === null ? null : resolvePath(sourceRoot, path);
    const builtPath = path === null ? null : resolvePath(buildRoot, path);
    return {
      index: sourceIndex,
      path,
      resolvedPath: isGenerated ? builtPath : sourcePath,
      sourcePath,
      buildPath: builtPath,
      isGenerated,
      sourceGroupIndex: Number.isInteger(source?.sourceGroupIndex) ? source.sourceGroupIndex : null,
      compileGroupIndex: Number.isInteger(source?.compileGroupIndex) ? source.compileGroupIndex : null,
    };
  });
}

function groupIndexes(group, kind, groupIndex, issues, location) {
  const indexes = Array.isArray(group?.sourceIndexes) ? group.sourceIndexes : [];
  if (!Array.isArray(group?.sourceIndexes)) {
    issues.push(issue(`${kind}-group-indexes-missing`,
      `配置 ${location.configuration} 的目标 ${location.targetId} 的${kind === 'source' ? '源码组' : '编译组'} ${groupIndex} 缺少 sourceIndexes`,
      { ...location, [`${kind}GroupIndex`]: groupIndex }));
  }
  return indexes;
}

function collectGroups(target, sources, issues, location) {
  const rawSourceGroups = Array.isArray(target.sourceGroups) ? target.sourceGroups : [];
  const rawCompileGroups = Array.isArray(target.compileGroups) ? target.compileGroups : [];
  const sourceGroups = rawSourceGroups.map((group, groupIndex) => {
    const groupLocation = { ...location, sourceGroupIndex: groupIndex };
    const sourceIndexes = groupIndexes(group, 'source', groupIndex, issues, location);
    for (const sourceIndex of sourceIndexes) {
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sources.length) {
        issues.push(issue('source-group-index-out-of-range',
          `配置 ${location.configuration} 的目标 ${location.targetId} 的源码组 ${groupIndex} 引用了越界源码下标 ${String(sourceIndex)}`,
          { ...groupLocation, sourceIndex }));
      }
    }
    return {
      ...(group && typeof group === 'object' ? group : {}),
      index: groupIndex,
      name: typeof group?.name === 'string' ? group.name : null,
      sourceIndexes,
      sources: sourceIndexes
        .filter(sourceIndex => Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length)
        .map(sourceIndex => sources[sourceIndex].resolvedPath),
      buildSources: sourceIndexes
        .filter(sourceIndex => Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length)
        .map(sourceIndex => sources[sourceIndex].buildPath),
    };
  });
  const compileGroups = rawCompileGroups.map((group, groupIndex) => {
    const groupLocation = { ...location, compileGroupIndex: groupIndex };
    const sourceIndexes = groupIndexes(group, 'compile', groupIndex, issues, location);
    for (const sourceIndex of sourceIndexes) {
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sources.length) {
        issues.push(issue('compile-group-index-out-of-range',
          `配置 ${location.configuration} 的目标 ${location.targetId} 的编译组 ${groupIndex} 引用了越界源码下标 ${String(sourceIndex)}`,
          { ...groupLocation, sourceIndex }));
      }
    }
    return {
      ...(group && typeof group === 'object' ? group : {}),
      index: groupIndex,
      language: typeof group?.language === 'string' ? group.language : null,
      sourceIndexes,
      sources: sourceIndexes
        .filter(sourceIndex => Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length)
        .map(sourceIndex => sources[sourceIndex].resolvedPath),
      compileCommandFragments: Array.isArray(group?.compileCommandFragments) ? group.compileCommandFragments : [],
    };
  });
  for (const source of sources) {
    if (source.sourceGroupIndex !== null
      && (source.sourceGroupIndex < 0 || source.sourceGroupIndex >= sourceGroups.length)) {
      issues.push(issue('source-group-index-out-of-range',
        `配置 ${location.configuration} 的目标 ${location.targetId} 的源码 ${source.path ?? `#${source.index}`} 引用了越界源码组 ${source.sourceGroupIndex}`,
        { ...location, sourceIndex: source.index, sourceGroupIndex: source.sourceGroupIndex }));
    }
    if (source.compileGroupIndex !== null
      && (source.compileGroupIndex < 0 || source.compileGroupIndex >= compileGroups.length)) {
      issues.push(issue('compile-group-index-out-of-range',
        `配置 ${location.configuration} 的目标 ${location.targetId} 的源码 ${source.path ?? `#${source.index}`} 引用了越界编译组 ${source.compileGroupIndex}`,
        { ...location, sourceIndex: source.index, compileGroupIndex: source.compileGroupIndex }));
    }
  }
  return { sourceGroups, compileGroups };
}

async function collectTarget({ targetRef, codemodel, configuration, client, snapshot, baseUrl, store, tracker }) {
  const issues = [];
  const targetLocation = {
    configuration,
    targetId: typeof targetRef?.id === 'string' ? targetRef.id : null,
    targetName: typeof targetRef?.name === 'string' ? targetRef.name : null,
    jsonFile: targetRef?.jsonFile ?? null,
  };
  if (!targetRef || typeof targetRef !== 'object') {
    issues.push(issue('target-reference-invalid', `配置 ${configuration} 含无效目标条目`, targetLocation));
    return { record: null, issues, status: 'failed' };
  }
  if (!isSafeReference(targetRef.jsonFile)) {
    issues.push(issue('target-reference-invalid',
      `配置 ${configuration} 的目标 ${targetLocation.targetId ?? '(无标识)'} 的 jsonFile 不可定位`,
      targetLocation));
    return { record: null, issues, status: 'failed' };
  }
  const received = await fetchDocument(baseUrl, targetRef.jsonFile, store, tracker, 'target', {
    configuration, targetId: targetLocation.targetId, targetName: targetLocation.targetName, attempt: snapshot.attempt,
  });
  if (received.error) {
    issues.push(issue('target-file-missing',
      `配置 ${configuration} 的目标 ${targetLocation.targetId ?? '(无标识)'} 引用的 ${targetRef.jsonFile} 无法读取：${received.error}`,
      targetLocation));
    return { record: null, issues, status: 'missing' };
  }
  const target = parseJson(received.bytes);
  if (!target || typeof target !== 'object') {
    issues.push(issue('target-json-invalid', `配置 ${configuration} 的目标文件 ${targetRef.jsonFile} 不是有效 JSON 对象`, targetLocation));
    return { record: null, issues, status: 'failed' };
  }
  const location = { ...targetLocation, targetId: target.id ?? targetLocation.targetId };
  if (target.id !== targetRef.id) {
    issues.push(issue('target-id-mismatch',
      `配置 ${configuration} 的目标文件 ${targetRef.jsonFile} 的 id 与 codemodel 声明不一致`,
      { ...location, declaredTargetId: targetRef.id, actualTargetId: target.id ?? null }));
  }
  if (target.name !== targetRef.name) {
    issues.push(issue('target-name-mismatch',
      `配置 ${configuration} 的目标文件 ${targetRef.jsonFile} 的名称与 codemodel 声明不一致`,
      { ...location, declaredTargetName: targetRef.name, actualTargetName: target.name ?? null }));
  }
  const roots = resolveRoots(codemodel, target, issues, location);
  const sources = buildSources(target, roots.sourceRoot, roots.buildRoot, issues, location);
  const { sourceGroups, compileGroups } = collectGroups(target, sources, issues, location);
  return {
    status: 'collected',
    issues,
    record: {
      configuration,
      targetId: target.id ?? targetRef.id ?? null,
      targetName: target.name ?? targetRef.name ?? null,
      name: target.name ?? targetRef.name ?? null,
      type: target.type ?? null,
      paths: roots.paths,
      sources,
      sourceGroups,
      compileGroups,
      provenance: {
        index: snapshot.index.name,
        client,
        query: `${client}/query.json`,
        codemodel: codemodel.reference,
        target: targetRef.jsonFile,
        replyDirectory: '/build/reply',
        sourceVersion: received.etag,
        digests: {
          index: snapshot.index.digest,
          codemodel: codemodel.digest,
          target: received.digest,
        },
      },
    },
  };
}

async function collectSnapshot({ baseUrl, store, client, wanted, attempt, tracker = { evidence: [], blobs: [], downloadedBytes: 0 } }) {
  const issues = [];
  const pointer = await readIndexPointer(baseUrl, store, tracker, { attempt });
  if (pointer.error) {
    return { fatal: issue('index-pointer-unavailable', pointer.error), issues, tracker, pointer: null, index: null };
  }
  const indexReceived = await fetchDocument(baseUrl, pointer.name, store, tracker, 'reply-index', { index: pointer.name, attempt });
  if (indexReceived.error) {
    return {
      fatal: issue('index-unavailable', `回复索引 ${pointer.name} 无法读取：${indexReceived.error}`, { index: pointer.name }),
      issues, tracker, pointer, index: null,
    };
  }
  const index = parseJson(indexReceived.bytes);
  const indexInfo = {
    name: pointer.name, digest: indexReceived.digest, etag: indexReceived.etag,
    bytes: indexReceived.bytes.length,
    objectsIgnored: Array.isArray(index?.objects) ? index.objects.length : 0,
  };
  if (!index || typeof index !== 'object') {
    return { fatal: issue('index-invalid', `回复索引 ${pointer.name} 不是有效 JSON 对象`, { index: pointer.name }), issues, tracker, pointer, index: indexInfo };
  }
  const located = locateCodemodel(index, client, wanted);
  if (located.issues) issues.push(...located.issues);
  if (located.fatal) {
    return { fatal: located.fatal, issues, tracker, pointer, index: indexInfo };
  }
  const codemodelRef = located.candidate.response.jsonFile;
  const codemodelReceived = await fetchDocument(baseUrl, codemodelRef, store, tracker, 'codemodel', {
    client, index: pointer.name, attempt,
  });
  if (codemodelReceived.error) {
    return {
      fatal: issue('codemodel-missing', `客户 ${client} 的 codemodel 文件 ${codemodelRef} 无法读取：${codemodelReceived.error}`,
        { client, jsonFile: codemodelRef }),
      issues, tracker, pointer, index: indexInfo,
    };
  }
  const codemodel = parseJson(codemodelReceived.bytes);
  const codemodelLocation = { client, index: pointer.name, jsonFile: codemodelRef };
  if (!codemodel || typeof codemodel !== 'object') {
    return { fatal: issue('codemodel-invalid', `codemodel 文件 ${codemodelRef} 不是有效 JSON 对象`, codemodelLocation), issues, tracker, pointer, index: indexInfo };
  }
  if (codemodel.kind !== 'codemodel') {
    return {
      fatal: issue('codemodel-kind-mismatch', `文件 ${codemodelRef} 的 kind 不是 codemodel`, { ...codemodelLocation, kind: codemodel.kind ?? null }),
      issues, tracker, pointer, index: indexInfo,
    };
  }
  const codemodelVersion = versionOf(codemodel.version);
  if (!codemodelVersion || codemodelVersion.major !== SUPPORTED_MAJOR) {
    return {
      fatal: issue('codemodel-version-unsupported', `codemodel 文件 ${codemodelRef} 的版本不受支持，仅支持 v2`,
        { ...codemodelLocation, version: codemodel.version ?? null }),
      issues, tracker, pointer, index: indexInfo,
    };
  }
  if (!Array.isArray(codemodel.configurations)) {
    return {
      fatal: issue('codemodel-configurations-invalid', `codemodel 文件 ${codemodelRef} 缺少 configurations 数组`, codemodelLocation),
      issues, tracker, pointer, index: indexInfo,
    };
  }
  const codemodelInfo = {
    reference: codemodelRef,
    jsonFile: codemodelRef,
    digest: codemodelReceived.digest,
    etag: codemodelReceived.etag,
    version: codemodelVersion,
    paths: codemodel.paths,
    responseVersion: versionOf(located.candidate.response.version),
    requestVersion: versionOf(located.candidate.request?.version),
  };
  if (codemodel.configurations.length === 0) {
    issues.push(issue('codemodel-empty', `codemodel 文件 ${codemodelRef} 未声明任何配置，本次没有可交付的目标资料`,
      codemodelLocation, 'warning'));
  }
  const records = [];
  const configurations = [];
  const seenConfigurations = new Set();
  const targets = { declared: 0, collected: 0, missingFiles: 0, failed: 0 };
  const sources = { total: 0, generated: 0 };
  const groups = { sourceGroups: 0, compileGroups: 0 };
  for (const configuration of codemodel.configurations) {
    const configurationName = typeof configuration?.name === 'string' ? configuration.name : null;
    if (configurationName === null) {
      issues.push(issue('configuration-name-missing', `codemodel ${codemodelRef} 含缺少名称的配置`, codemodelLocation));
    } else if (seenConfigurations.has(configurationName)) {
      issues.push(issue('configuration-duplicate', `codemodel ${codemodelRef} 含重复的配置名称 ${configurationName}`,
        { ...codemodelLocation, configuration: configurationName }));
    } else {
      seenConfigurations.add(configurationName);
    }
    configurations.push(configurationName);
    if (!Array.isArray(configuration?.targets)) {
      issues.push(issue('targets-invalid', `配置 ${configurationName ?? '(无名称)'} 缺少 targets 数组`,
        { ...codemodelLocation, configuration: configurationName }));
      continue;
    }
    const seenTargetIds = new Set();
    for (const targetRef of configuration.targets) {
      targets.declared += 1;
      if (targetRef && typeof targetRef.id === 'string') {
        if (seenTargetIds.has(targetRef.id)) {
          issues.push(issue('target-id-duplicate',
            `配置 ${configurationName ?? '(无名称)'} 重复声明目标 ${targetRef.id}，配置内目标标识应唯一`,
            { ...codemodelLocation, configuration: configurationName, targetId: targetRef.id }));
        }
        seenTargetIds.add(targetRef.id);
      }
      const result = await collectTarget({
        targetRef, codemodel: codemodelInfo, configuration: configurationName, client,
        snapshot: { index: indexInfo, attempt }, baseUrl, store, tracker,
      });
      issues.push(...result.issues);
      if (result.record) {
        records.push(result.record);
        targets.collected += 1;
        sources.total += result.record.sources.length;
        sources.generated += result.record.sources.filter(source => source.isGenerated).length;
        groups.sourceGroups += result.record.sourceGroups.length;
        groups.compileGroups += result.record.compileGroups.length;
      } else if (result.status === 'missing') {
        targets.missingFiles += 1;
      } else {
        targets.failed += 1;
      }
    }
  }
  return {
    fatal: null,
    issues,
    tracker,
    pointer,
    index: indexInfo,
    codemodel: codemodelInfo,
    records,
    configurations,
    targets,
    sources,
    groups,
  };
}

function summarize(issueList) {
  const errors = issueList.filter(item => item.severity === 'error').length;
  return { errors, warnings: issueList.length - errors };
}

function makeReceipt({ descriptor, client, issues, evidence, blobs, coverage, records, metadata, source, sourceVersion, fatal = false }) {
  const errors = issues.filter(item => item.severity === 'error');
  const state = fatal ? 'rejected' : (coverage.complete && errors.length === 0 ? 'complete' : 'partial');
  return {
    state,
    mode: 'structured',
    product: descriptor?.product ?? null,
    source: source ?? null,
    sourceVersion: sourceVersion ?? null,
    metadata,
    blobs: uniqueBlobs(blobs),
    records,
    issues,
    coverage: {
      structured: true,
      client,
      ...coverage,
      complete: state === 'complete',
      buildCommandsExecuted: false,
      diskChecked: false,
      note: '生成路径仅按 codemodel 标注，不要求当前磁盘存在；未运行任何项目构建命令',
    },
    evidence,
  };
}

export async function collectCodemodel({ input, descriptor, sourceBase, store }) {
  const client = input.client === undefined || input.client === null ? DEFAULT_CLIENT : input.client;
  if (!isSafeClient(client)) {
    return makeReceipt({
      descriptor, client: null,
      issues: [issue('client-invalid', '客户名称无效，无法按客户请求定位回复对象', { client })],
      evidence: [], blobs: [], records: [],
      metadata: { format: 'CMake File API', client: null },
      coverage: { attempts: 0, indexChanges: 0, complete: false },
      fatal: true,
    });
  }
  const wanted = normalizeWantedVersion(input.version);
  if (wanted === null) {
    return makeReceipt({
      descriptor, client,
      issues: [issue('version-invalid', '请求的 codemodel 版本无效', { client, version: input.version })],
      evidence: [], blobs: [], records: [],
      metadata: { format: 'CMake File API', client },
      coverage: { attempts: 0, indexChanges: 0, complete: false },
      fatal: true,
    });
  }
  const issues = [];
  const evidence = [];
  const blobs = [];
  const attempts = [];
  let indexChanges = 0;
  let current = null;
  let chosenIssues = null;
  let stable = null;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptCount = attempt;
    const attemptEvidence = [];
    const attemptBlobs = [];
    const snapshot = await collectSnapshot({
      baseUrl: sourceBase, store, client, wanted, attempt,
      tracker: { evidence: attemptEvidence, blobs: attemptBlobs, downloadedBytes: 0 },
    });
    evidence.push(...attemptEvidence);
    blobs.push(...attemptBlobs);
    const snapshotIssues = snapshot.fatal ? [...snapshot.issues, snapshot.fatal] : snapshot.issues;
    attempts.push({
      attempt,
      index: snapshot.index?.name ?? null,
      indexDigest: snapshot.index?.digest ?? null,
      codemodel: snapshot.codemodel?.jsonFile ?? null,
      status: snapshot.fatal ? 'rejected' : 'collected',
      records: snapshot.records?.length ?? 0,
      issues: summarize(snapshotIssues),
    });
    if (snapshot.fatal) {
      current = snapshot;
      chosenIssues = snapshotIssues;
      break;
    }
    const verification = await readIndexPointer(sourceBase, store, { evidence, blobs, downloadedBytes: 0 }, { attempt, purpose: 'verification' });
    if (verification.error) {
      issues.push(issue('index-verification-failed', `收件结束时无法复核回复索引：${verification.error}`, { attempt, index: snapshot.index.name }));
      current = snapshot;
      chosenIssues = snapshotIssues;
      continue;
    }
    if (verification.name !== snapshot.index.name) {
      indexChanges += 1;
      issues.push(issue('index-changed',
        `收件期间回复索引由 ${snapshot.index.name} 变为 ${verification.name}；旧回复对象可能仍留在目录中，已按新索引重新收集，未沿用旧目标资料`,
        { attempt, previousIndex: snapshot.index.name, currentIndex: verification.name, previousDigest: snapshot.index.digest, currentDigest: verification.digest },
        'warning'));
      current = snapshot;
      chosenIssues = snapshotIssues;
      continue;
    }
    const verificationFile = await fetchDocument(sourceBase, verification.name, store, { evidence, blobs, downloadedBytes: 0 }, 'index-verification', {
      attempt, index: verification.name,
    });
    if (verificationFile.error) {
      issues.push(issue('index-verification-failed',
        `收件结束时无法复核回复索引 ${verification.name}：${verificationFile.error}`, { attempt, index: verification.name }));
      current = snapshot;
      chosenIssues = snapshotIssues;
      continue;
    }
    if (verificationFile.digest !== snapshot.index.digest) {
      indexChanges += 1;
      issues.push(issue('index-changed',
        `收件期间回复索引 ${snapshot.index.name} 的内容发生变化；旧回复对象可能仍留在目录中，已按新索引重新收集，未沿用旧目标资料`,
        { attempt, index: snapshot.index.name, previousDigest: snapshot.index.digest, currentDigest: verificationFile.digest },
        'warning'));
      current = snapshot;
      chosenIssues = snapshotIssues;
      continue;
    }
    stable = snapshot;
    current = snapshot;
    chosenIssues = snapshotIssues;
    break;
  }
  if (!stable && !current?.fatal) {
    issues.push(issue('index-unstable',
      `经过 ${attemptCount} 次收集仍无法获得稳定的回复索引；已保留末次快照，但未将不同索引下的残留对象拼接为完整构建`,
      { attempts: attemptCount, indexChanges }, 'warning'));
  }
  const chosen = stable ?? current;
  const finalIssues = [...issues, ...(chosenIssues ?? [])];
  const errors = finalIssues.filter(item => item.severity === 'error');
  const hasGaps = Boolean(chosen?.targets && chosen.targets.collected < chosen.targets.declared);
  const coverage = {
    index: chosen?.index?.name ?? null,
    indexDigest: chosen?.index?.digest ?? null,
    indexEtag: chosen?.index?.etag ?? null,
    objectsIgnored: chosen?.index?.objectsIgnored ?? 0,
    codemodel: chosen?.codemodel?.jsonFile ?? null,
    codemodelVersion: chosen?.codemodel?.version ?? null,
    configurations: chosen?.configurations ?? [],
    targets: chosen?.targets ?? { declared: 0, collected: 0, missingFiles: 0, failed: 0 },
    sources: chosen?.sources ?? { total: 0, generated: 0 },
    groups: chosen?.groups ?? { sourceGroups: 0, compileGroups: 0 },
    attempts: attemptCount,
    attemptLog: attempts,
    indexChanges,
    stableIndex: Boolean(stable),
    issues: summarize(finalIssues),
    downloadedBytes: evidence.reduce((total, item) => total + (item.bytes ?? 0), 0),
    complete: Boolean(stable) && errors.length === 0 && !hasGaps && indexChanges === 0,
  };
  return makeReceipt({
    descriptor, client,
    issues: finalIssues,
    evidence,
    blobs,
    records: chosen?.records ?? [],
    fatal: Boolean(chosen?.fatal),
    metadata: {
      format: 'CMake File API',
      client,
      index: chosen?.index?.name ?? null,
      codemodel: chosen?.codemodel?.jsonFile ?? null,
      versions: chosen?.codemodel?.version ?? null,
    },
    source: chosen?.index?.name ?? null,
    sourceVersion: chosen?.index?.etag ?? null,
    coverage,
  });
}
