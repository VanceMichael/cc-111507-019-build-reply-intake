import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
const dataDir = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const service = await createService({ dataDir });
try {
  const source = await (await fetch(`${service.baseUrl}/v1/source`)).json();
  console.log('来源资料', JSON.stringify(source, null, 2));
  const raw = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'raw' }) });
  console.log('原始收件', JSON.stringify(await raw.json(), null, 2));
  const structured = await fetch(`${service.baseUrl}/v1/intakes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'structured', client: 'client-release' }) });
  const receipt = await structured.json();
  console.log('结构化收件状态', receipt.state, '记录数', receipt.records.length, '问题数', receipt.issues.length);
  console.log('结构化收件', JSON.stringify(receipt, null, 2));
  console.log('收件目录', JSON.stringify(await (await fetch(`${service.baseUrl}/v1/receipts`)).json(), null, 2));
} finally { await service.close(); await rm(dataDir, { recursive: true, force: true }); }
