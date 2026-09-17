// =============================================================================
// 上传韧性验证（v1.1.5）：瞬时故障自动重试 + 暂停/继续（无需真实后端/浏览器）
// 运行： node --import ./e2e/ts-register.mjs e2e/_upload-resilience.ts
// 环境说明：受限沙箱内无法启动 esbuild/tsx（spawn EPERM），故用 Node 原生 TS 类型剥离
//            + 伪造 XHR / fetch / localStorage，验证上传引擎与队列的真实运行逻辑。
// 覆盖场景：
//   1) 分片 PUT 503/403（签名过期）→ 自动重试 + 重新签名，用户无需手动点「重试」
//   2) complete 503 → 自动退避重试
//   3) 暂停（AbortSignal）→ 立即中断、保留断点；继续 → 只补缺失分片（不重复上传）
//   4) 不可重试错误（400）→ 立即失败并标记 retryable=false（不无谓等待）
//   5) 队列「全部暂停 / 一键全部继续」（用户核心诉求）
// =============================================================================

// ---------- 0. 运行时桩（必须在 import 业务模块之前安装） ----------
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
  /** 测试辅助：读取原始 JSON */
  raw(k: string): string | null {
    return this.getItem(k);
  }
}

const PART_SIZE = 1024;
const PUT_DELAY_MS = 150;

interface Session {
  id: string;
  name: string;
  size: number;
  partSize: number;
  totalParts: number;
  uploaded: Set<number>;
  status: number;
}

const server = {
  sessions: new Map<string, Session>(),
  partPutFails: new Map<number, number[]>(), // part -> 依次注入的 HTTP 失败码（每次尝试消费一个）
  partDelays: new Map<number, number>(), // part -> 单次 PUT 耗时（模拟大小不一的传输）
  putAttempts: new Map<string, number>(), // `${sessionId}:${part}` -> 尝试次数
  abortedPuts: 0,
  putStarts: 0,
  presignCalls: 0,
  presignFailures: [] as number[],
  initFailures: [] as number[],
  initCalls: 0,
  initError: undefined as { status: number; message: string } | undefined,
  completeCalls: 0,
  completeFailures: [] as number[],
  sessionSeq: 0,
};

function resetServer(): void {
  server.sessions.clear();
  server.partPutFails.clear();
  server.partDelays.clear();
  server.putAttempts.clear();
  server.abortedPuts = 0;
  server.putStarts = 0;
  server.presignCalls = 0;
  server.presignFailures = [];
  server.initFailures = [];
  server.initCalls = 0;
  server.initError = undefined;
  server.completeCalls = 0;
  server.completeFailures = [];
  server.sessionSeq = 0;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

class FakeXHR {
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  private etag = '';
  private url = '';
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  open(_method: string, url: string): void {
    this.url = url;
  }
  setRequestHeader(): void {
    /* 忽略 */
  }
  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'etag' && this.status >= 200 && this.status < 300 ? `"${this.etag}"` : null;
  }
  send(blob: { size: number }): void {
    const u = new URL(this.url);
    const part = Number(u.searchParams.get('part'));
    const sessId = u.pathname.replace(/^\//, '');
    const key = `${sessId}:${part}`;
    const attempt = (server.putAttempts.get(key) ?? 0) + 1;
    server.putAttempts.set(key, attempt);
    server.putStarts += 1;
    const delay = server.partDelays.get(part) ?? PUT_DELAY_MS;
    const total = blob.size;
    // 进度：两次上报
    for (let i = 1; i <= 2; i++) {
      setTimeout(() => {
        if (!this.aborted) this.upload.onprogress?.({ lengthComputable: true, loaded: Math.round((total * i) / 2), total });
      }, (delay / 2) * i);
    }
    this.timer = setTimeout(() => {
      if (this.aborted) return;
      // 全局消费式故障注入：每尝试一次弹出一个失败码（跨会话，便于验证「会话失效后重开自愈」）
      const failStatus = (server.partPutFails.get(part) ?? []).shift();
      if (failStatus) {
        this.status = failStatus;
        this.onload?.();
        return;
      }
      const sess = server.sessions.get(sessId);
      if (!sess) {
        this.status = 404;
        this.onload?.();
        return;
      }
      sess.uploaded.add(part);
      this.status = 200;
      this.etag = `etag-${sessId}-${part}`;
      this.onload?.();
    }, delay);
  }
  abort(): void {
    this.aborted = true;
    server.abortedPuts += 1;
    if (this.timer) clearTimeout(this.timer);
    setTimeout(() => this.onabort?.(), 0);
  }
}

const mem = new MemStorage();
(globalThis as any).localStorage = mem;
(globalThis as any).document = { cookie: 'nd_csrf=test-csrf' };
(globalThis as any).XMLHttpRequest = FakeXHR;
(globalThis as any).fetch = async (input: any, init: any = {}): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input.url;
  const u = new URL(raw, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const route = u.pathname;

  if (route === '/api/files/upload/init' && method === 'POST') {
    server.initCalls += 1;
    if (server.initError) return jsonResponse({ code: 'BAD_REQUEST', message: server.initError.message }, server.initError.status);
    const fail = server.initFailures.shift();
    if (fail) return jsonResponse({ code: 'INTERNAL_ERROR', message: '服务内部错误' }, fail);
    const id = `sess-${++server.sessionSeq}`;
    const totalParts = Math.max(1, Math.ceil(body.size / PART_SIZE));
    server.sessions.set(id, {
      id,
      name: body.name,
      size: body.size,
      partSize: PART_SIZE,
      totalParts,
      uploaded: new Set(),
      status: 0,
    });
    return jsonResponse({ dedup: false, session: { id, mode: 2, partSize: PART_SIZE, totalParts } });
  }

  if (route === '/api/files/upload/presign-parts' && method === 'POST') {
    server.presignCalls += 1;
    const fail = server.presignFailures.shift();
    if (fail) return jsonResponse({ code: 'INTERNAL_ERROR', message: '服务内部错误' }, fail);
    const { sessionId, partNumbers } = body as { sessionId: string; partNumbers: number[] };
    const sig = server.presignCalls;
    return jsonResponse({
      parts: partNumbers.map((n) => ({ partNumber: n, url: `https://minio.local/${sessionId}?part=${n}&sig=${sig}`, expires: 3600 })),
    });
  }

  if (route === '/api/files/upload/parts-report' && method === 'POST') {
    const sess = server.sessions.get(body.sessionId);
    for (const n of body.partNumbers ?? []) sess?.uploaded.add(n);
    return jsonResponse({ uploaded: [...(sess?.uploaded ?? [])] });
  }

  if (route === '/api/files/upload/parts' && method === 'GET') {
    const sess = server.sessions.get(String(u.searchParams.get('sessionId')));
    return jsonResponse({
      uploaded: [...(sess?.uploaded ?? [])],
      totalParts: sess?.totalParts ?? 0,
      partSize: PART_SIZE,
      size: sess?.size ?? 0,
    });
  }

  if (route === '/api/files/upload/complete' && method === 'POST') {
    server.completeCalls += 1;
    const fail = server.completeFailures.shift();
    if (fail) return jsonResponse({ code: 'INTERNAL_ERROR', message: '服务内部错误' }, fail);
    const sess = server.sessions.get(body.sessionId);
    if (!sess) return jsonResponse({ code: 'NOT_FOUND', message: '上传会话不存在' }, 404);
    const missing: number[] = [];
    for (let n = 1; n <= sess.totalParts; n++) if (!sess.uploaded.has(n)) missing.push(n);
    if (missing.length > 0) {
      return jsonResponse({ code: 'BAD_REQUEST', message: `缺少已上传分片信息（${missing.join(',')}）` }, 400);
    }
    sess.status = 1;
    return jsonResponse({ id: sess.id, name: sess.name, size: sess.size, type: 'file' });
  }

  throw new Error(`[mock] 未实现的接口：${method} ${raw}`);
};

// ---------- 1. 测试工具 ----------
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function makeFile(name: string, size: number): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + name.length) % 251;
  return new File([bytes], name, { type: 'application/octet-stream' });
}
function uploadedParts(sessionId: string): number[] {
  return [...(server.sessions.get(sessionId)?.uploaded ?? [])].sort((a, b) => a - b);
}

// ---------- 2. 用例 ----------
async function main(): Promise<void> {
  const { runUploadTask } = await import('../web/src/utils/uploader');
  const { useUploadStore } = await import('../web/src/store/upload');

  // ===== 用例 1：瞬时故障自动重试（对应用户报的「请求失败，请稍后重试，点重试又能成功」）=====
  console.log('\n=== 1. 瞬时故障自动重试（无需用户手动点重试）===');
  resetServer();
  // 第一个分片：先 503 再 403（签名过期）→ 第三次成功；complete 前两次 503
  server.partPutFails.set(1, [503, 403]);
  server.presignFailures = [503];
  server.completeFailures = [503, 502];
  const f1 = makeFile('retry.bin', PART_SIZE * 3);
  let lastProgress = 0;
  const r1 = await runUploadTask(
    { id: 't1', fileName: f1.name, size: f1.size, dirId: 'dir-1', file: f1 },
    (p) => {
      lastProgress = p.bytesDone;
    }
  );
  check('瞬时故障后自动重试成功', r1.status === 'completed', `status=${r1.status}${r1.error ? ` err=${r1.error}` : ''}`);
  check('分片1被重试 3 次（503→403→成功）', server.putAttempts.get('sess-1:1') === 3, `attempts=${server.putAttempts.get('sess-1:1')}`);
  check('403（签名过期）触发了重新签名', server.presignCalls > 2, `presignCalls=${server.presignCalls}`);
  check('complete 瞬时失败被自动重试', server.completeCalls === 3, `completeCalls=${server.completeCalls}`);
  check('进度回显到文件总大小', lastProgress === f1.size, `progress=${lastProgress}/${f1.size}`);

  // ===== 用例 2：暂停 → 继续（断点续传，不重复上传已完成分片）=====
  console.log('\n=== 2. 暂停后继续：断点保留、已完成分片不重传 ===');
  resetServer();
  // 分片 1/2 先传完，分片 3/4 仍在传输时暂停
  server.partDelays.set(1, 40);
  server.partDelays.set(2, 70);
  server.partDelays.set(3, 600);
  server.partDelays.set(4, 600);
  const f2 = makeFile('pause.bin', PART_SIZE * 4);
  const ctrl = new AbortController();
  const runP = runUploadTask({ id: 't2', fileName: f2.name, size: f2.size, dirId: 'dir-2', file: f2 }, () => undefined, {
    signal: ctrl.signal,
  });
  await sleep(200);
  ctrl.abort();
  const r2 = await runP;
  check('暂停返回 paused（非错误）', r2.status === 'paused', `status=${r2.status}`);
  check('暂停时确实中断了在传请求', server.abortedPuts > 0, `abortedPuts=${server.abortedPuts}`);
  await sleep(50);
  const beforeParts = uploadedParts('sess-1');
  const attemptsBefore = new Map(server.putAttempts);
  check('暂停时已保留部分分片进度', beforeParts.length === 2, `uploaded=${beforeParts.join(',')}`);

  // 模拟「继续上传」：同一文件 + 同一目录（key 一致）重新入队
  const r2b = await runUploadTask({ id: 't2', fileName: f2.name, size: f2.size, dirId: 'dir-2', file: f2 }, () => undefined, {
    signal: new AbortController().signal,
  });
  check('继续后上传完成', r2b.status === 'completed', `status=${r2b.status}${r2b.error ? ` err=${r2b.error}` : ''}`);
  check('复用同一会话（未重开会话）', server.sessionSeq === 1, `sessionSeq=${server.sessionSeq}`);
  const reuploaded = beforeParts.filter((p) => (server.putAttempts.get(`sess-1:${p}`) ?? 0) > (attemptsBefore.get(`sess-1:${p}`) ?? 0));
  check('暂停前已完成的分片没有被重新上传', reuploaded.length === 0, `reuploaded=[${reuploaded.join(',')}]`);
  check('服务端最终分片齐全', uploadedParts('sess-1').length === 4, `parts=${uploadedParts('sess-1').join(',')}`);

  // ===== 用例 3：不可重试错误立即失败（不无谓等待）=====
  console.log('\n=== 3. 不可重试错误（400）立即失败 ===');
  resetServer();
  server.initError = { status: 400, message: '存储空间不足' };
  const f3 = makeFile('quota.bin', PART_SIZE);
  const t0 = Date.now();
  const r3 = await runUploadTask({ id: 't3', fileName: f3.name, size: f3.size, dirId: 'dir-3', file: f3 }, () => undefined);
  const cost = Date.now() - t0;
  check('返回错误状态', r3.status === 'error', `status=${r3.status}`);
  check('标记为不可重试（队列不会自动重排）', r3.retryable === false, `retryable=${r3.retryable}`);
  check('未做无谓重试（init 仅 1 次，耗时 < 1s）', server.initCalls === 1 && cost < 1000, `initCalls=${server.initCalls} cost=${cost}ms`);
  check('错误信息透传给用户', (r3.error ?? '').includes('存储空间不足'), `error=${r3.error}`);

  // ===== 用例 4：队列「全部暂停 / 一键全部继续」=====
  console.log('\n=== 4. 队列：全部暂停 + 一键全部继续 ===');
  resetServer();
  // 分片 1/2 快速完成，分片 3/4 慢（保证暂停时确有在传请求 + 已保留断点）
  server.partDelays.set(1, 60);
  server.partDelays.set(2, 60);
  server.partDelays.set(3, 1500);
  server.partDelays.set(4, 1500);
  useUploadStore.setState({ tasks: {}, visible: true, paused: false, pauseReason: undefined, _running: 0 });
  const files = [1, 2, 3].map((i) => makeFile(`q-${i}.bin`, PART_SIZE * 4));
  useUploadStore.getState().addFiles(files, 'dir-q');
  await sleep(220);
  const midActive = Object.values(useUploadStore.getState().tasks).filter((t) => t.status === 'uploading' || t.status === 'hashing');
  check('文件已入队并开始传输', Object.keys(useUploadStore.getState().tasks).length === 3 && midActive.length === 3, `active=${midActive.length}`);

  useUploadStore.getState().pauseAll();
  await sleep(600);
  const afterPause = Object.values(useUploadStore.getState().tasks);
  const notDone = afterPause.filter((t) => t.status !== 'completed');
  check('全部暂停后无进行中任务', notDone.every((t) => t.status === 'paused'), `states=${afterPause.map((t) => t.status).join(',')}`);
  check(
    '暂停保留了已完成分片的断点',
    uploadedParts('sess-1').length + uploadedParts('sess-2').length + uploadedParts('sess-3').length === 6,
    `parts=${['sess-1', 'sess-2', 'sess-3'].map((id) => uploadedParts(id).length).join('/')}`
  );
  const pausedStore = useUploadStore.getState();
  check('全局暂停标记生效（不再调度新任务）', pausedStore.paused === true && pausedStore.pauseReason === 'user');

  useUploadStore.getState().resumeAll();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const all = Object.values(useUploadStore.getState().tasks);
    if (all.length === 3 && all.every((t) => t.status === 'completed' || t.status === 'dedup')) break;
    await sleep(100);
  }
  const afterResume = Object.values(useUploadStore.getState().tasks);
  check('一键全部继续后 3 个任务全部完成', afterResume.every((t) => t.status === 'completed'), `states=${afterResume.map((t) => t.status).join(',')}`);
  const allPartsOk = ['sess-1', 'sess-2', 'sess-3'].every((id) => uploadedParts(id).length === 4);
  check('服务端三个会话分片齐全（无漏传）', allPartsOk, `parts=${['sess-1', 'sess-2', 'sess-3'].map((id) => uploadedParts(id).length).join('/')}`);
  check('继续后解除全局暂停', useUploadStore.getState().paused === false);

  // ===== 用例 5：任务级自动重试（会话失效 → 重开会话自愈）=====
  console.log('\n=== 5. 会话失效自愈（任务级自动重试）===');
  resetServer();
  useUploadStore.setState({ tasks: {}, visible: true, paused: false, pauseReason: undefined, _running: 0 });
  // 第一个会话的分片 1 PUT 返回 404（MinIO 侧分片丢失）→ 引擎放弃该会话，任务级重试重开会话后应成功
  server.partPutFails.set(1, [404]);
  server.partDelays.set(1, 40);
  server.partDelays.set(2, 40);
  const f5 = makeFile('heal.bin', PART_SIZE * 2);
  useUploadStore.getState().addFiles([f5], 'dir-h');
  const deadline5 = Date.now() + 20000;
  while (Date.now() < deadline5) {
    const t = Object.values(useUploadStore.getState().tasks)[0];
    if (t && (t.status === 'completed' || t.status === 'error')) break;
    await sleep(100);
  }
  const t5 = Object.values(useUploadStore.getState().tasks)[0];
  check('会话失效后自动重开会话并完成上传', t5?.status === 'completed', `status=${t5?.status} err=${t5?.error ?? ''} sessions=${server.sessionSeq}`);
  // 成功后 attempts 会被重置为 0，故以「重开会话」作为任务级重试确实发生的证据
  check('任务级自动重试确实重开了会话', server.sessionSeq >= 2 && server.initCalls >= 2, `sessions=${server.sessionSeq} initCalls=${server.initCalls}`);

  // ===== 用例 6：目标目录已被删除（404 目录不存在）→ 立即失败、不重试、清断点 =====
  console.log('\n=== 6. 目标目录不存在：不重试、清断点（防 404 风暴）===');
  resetServer();
  server.initError = { status: 404, message: '目录不存在' };
  const f6 = makeFile('dirgone.bin', PART_SIZE * 2);
  const t0b = Date.now();
  const r6 = await runUploadTask({ id: 't6', fileName: f6.name, size: f6.size, dirId: 'dir-gone', file: f6 }, () => undefined);
  const cost6 = Date.now() - t0b;
  check('返回错误状态', r6.status === 'error', `status=${r6.status}`);
  check('标记 dirMissing 且不可重试', r6.dirMissing === true && r6.retryable === false, `dirMissing=${r6.dirMissing} retryable=${r6.retryable}`);
  check('init 只尝试 1 次（不做无谓重试）', server.initCalls === 1, `initCalls=${server.initCalls} 耗时=${cost6}ms`);
  check('提示信息可读', (r6.error ?? '').includes('目标目录已不存在'), `error=${r6.error}`);
  const { loadResumeRecord } = await import('../web/src/utils/resume-store');
  const rec6 = await loadResumeRecord(`dir-gone:${f6.name}:${f6.size}`);
  check('断点记录已清理（下次页面加载不会再白试）', rec6 === null, `record=${rec6 ? '仍存在' : '已清理'}`);

  // ---------- 汇总 ----------
  console.log(`\n===== 结果：通过 ${passed} 项，失败 ${failed} 项 =====`);
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error('[harness] 运行异常：', e);
  process.exit(1);
});
