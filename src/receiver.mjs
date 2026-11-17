import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { collectStructured } from './cmake-intake.mjs';

const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') return collectRaw({ descriptor, sourceBase, store });
  if (input.mode === 'structured') {
    if (typeof input.client !== 'string' || !CLIENT_NAME.test(input.client)) {
      throw new Error('结构化收件需要合法的 client 标识，对应客户 query.json 请求名');
    }
    return collectStructured({ input, descriptor, sourceBase, store });
  }
  // mode 已在 server 入口校验；保留兜底，未知方式按请求错误处理而非 501。
  throw new Error('接收方式无效');
}

async function collectRaw({ descriptor, sourceBase, store }) {
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
    records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
  return { receipt };
}
