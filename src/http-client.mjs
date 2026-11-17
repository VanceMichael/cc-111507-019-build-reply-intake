import { createHash } from 'node:crypto';
export async function receiveBytes(url, { headers = {}, limit = 16777216 } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`来源返回 ${response.status}`);
  const parts = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > limit) throw new Error('来源超出收件限额');
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  return { bytes, status: response.status, etag: response.headers.get('etag'), contentRange: response.headers.get('content-range'),
    digest: createHash('sha256').update(bytes).digest('hex') };
}

// 结构化收件使用：HTTP 错误状态不抛异常，交由上层记录为可定位 issue；网络层故障才抛出。
export async function receiveResource(url, { headers = {}, limit = 16777216 } = {}) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  } catch (error) {
    return { ok: false, status: 0, bytes: Buffer.alloc(0), etag: null, digest: null, error: `来源连接失败：${error.message}` };
  }
  const parts = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > limit) throw new Error('来源超出收件限额');
    parts.push(chunk);
  }
  const bytes = Buffer.concat(parts);
  return { ok: response.ok, status: response.status, bytes, etag: response.headers.get('etag'),
    digest: createHash('sha256').update(bytes).digest('hex') };
}
