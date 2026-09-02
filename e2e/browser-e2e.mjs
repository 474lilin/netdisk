// =============================================================================
// 浏览器端到端验证：登录(真实CSRF流程) -> 上传队列(分片进度) -> 表格刷新 -> 预览
// 使用 playwright-core + 本机 Edge（无需下载浏览器）
// 用法: cd e2e && npm install && node browser-e2e.mjs
// =============================================================================
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name} ${extra}`);
  if (!cond) failures++;
};

// ---------- 准备测试文件 ----------
const bigSize = 30 * 1024 * 1024; // 30MB > 8MB 阈值 -> 分片上传(2片)
const bigPath = path.join(TMP, 'e2e-big-30mb.bin');
const noteContent = '企业网盘浏览器E2E验证 ' + Date.now() + '\n第二行内容\n';
const notePath = path.join(TMP, 'e2e-note.txt');
if (!fs.existsSync(bigPath)) fs.writeFileSync(bigPath, crypto.randomBytes(bigSize));
fs.writeFileSync(notePath, noteContent);

// ---------- 启动浏览器 ----------
console.log('[0] 启动无头 Edge ...');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  // ---------- 1. 登录页 ----------
  console.log('\n=== 1. 登录 ===');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  check('登录页渲染', await page.isVisible('text=企业私有化网盘'));
  await page.screenshot({ path: path.join(SHOTS, '01-login.png') });

  await page.fill('input[placeholder="登录名"]', get('ADMIN_USERNAME'));
  await page.fill('input[placeholder="密码"]', get('ADMIN_PASSWORD'));
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$|\/\?dirId=/, { timeout: 15000 });
  await page.waitForSelector('table', { timeout: 15000 });
  await page.waitForTimeout(800);
  check('登录成功并进入文件页', true, `(URL=${page.url()})`);
  const rootsVisible = await page.isVisible('text=企业公共盘');
  check('侧边栏空间导航渲染', rootsVisible);
  await page.screenshot({ path: path.join(SHOTS, '02-files.png') });

  // ---------- 2. 上传（antd Upload 触发上传队列） ----------
  console.log('\n=== 2. 上传文件（30MB 分片 + 文本） ===');
  const input = page.locator('input.ant-upload-input, input[type="file"]').first();
  await input.setInputFiles([bigPath, notePath]);
  // 上传队列抽屉应自动打开
  await page.waitForSelector('text=上传队列', { timeout: 8000 });
  check('上传队列抽屉自动打开', true);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '03-uploading.png') });

  // 等待两个任务完成（30MB 分片 + 文本秒传）
  await page.waitForFunction(
    () => {
      const txt = document.body.innerText;
      const doneCount = (txt.match(/已完成|秒传\(去重\)/g) || []).length;
      return doneCount >= 2;
    },
    { timeout: 120000 }
  );
  check('上传任务全部完成(队列显示已完成/秒传)', true);
  await page.screenshot({ path: path.join(SHOTS, '04-upload-done.png') });

  // ---------- 3. 表格刷新后可见 ----------
  await page.waitForSelector(`text=${path.basename(bigPath)}`, { timeout: 15000 });
  await page.waitForSelector(`text=${path.basename(notePath)}`, { timeout: 15000 });
  check('文件出现在列表中', true);
  await page.screenshot({ path: path.join(SHOTS, '05-file-list.png') });

  // ---------- 4. 预览（点击文件名打开预览弹窗） ----------
  console.log('\n=== 3. 文件预览 ===');
  // 先关闭上传队列抽屉，避免同名文本干扰
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const noteRow = page.locator('tr', { hasText: path.basename(notePath) }).first();
  await noteRow.locator('.file-name-cell').click();
  try {
    await page.waitForSelector('.text-preview', { timeout: 15000 });
    const previewText = await page.textContent('.text-preview');
    check('文本预览内容一致', previewText.includes('企业网盘浏览器E2E验证'));
    await page.screenshot({ path: path.join(SHOTS, '06-preview.png') });
  } catch (e) {
    check('文本预览弹窗打开', false, '(详见下方诊断)');
    // 诊断：弹窗是否出现？页面上有什么？
    const modalVisible = await page.isVisible('.ant-modal');
    const bodyText = (await page.textContent('body') || '').slice(0, 800);
    console.log('  [诊断] 弹窗存在:', modalVisible);
    console.log('  [诊断] 页面文本片段:', JSON.stringify(bodyText.replace(/\s+/g, ' ').slice(0, 400)));
    console.log('  [诊断] console错误:', JSON.stringify(consoleErrors.slice(0, 5)));
    console.log('  [诊断] page错误:', JSON.stringify(pageErrors.slice(0, 3)));
    await page.screenshot({ path: path.join(SHOTS, '99-preview-fail.png') });
    throw e;
  }
  // 关闭预览弹窗（点击关闭按钮并等待消失，避免遮挡后续操作）
  await page.locator('.ant-modal-close').click();
  await page.waitForSelector('.ant-modal', { state: 'detached', timeout: 8000 });

  // ---------- 5. 分享弹窗 UI ----------
  console.log('\n=== 4. 分享弹窗 ===');
  const row = page.locator('tr', { hasText: path.basename(bigPath) }).first();
  await row.hover();
  await row.locator('button').last().click();
  // 等待行操作下拉菜单出现后再点击"分享"
  await page.waitForSelector('.ant-dropdown-menu-item:has-text("分享")', { timeout: 8000 });
  await page.locator('.ant-dropdown-menu-item:has-text("分享")').click();
  await page.waitForSelector('text=生成分享链接', { timeout: 8000 });
  check('分享弹窗打开', true);
  await page.screenshot({ path: path.join(SHOTS, '07-share.png') });
  await page.locator('.ant-modal-close').click();
  await page.waitForSelector('.ant-modal', { state: 'detached', timeout: 8000 });

  // ---------- 6. 控制台错误检查 ----------
  console.log('\n=== 5. 控制台/页面错误 ===');
  const realErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('download the Vue Devtools'));
  check('无页面异常', pageErrors.length === 0 && realErrors.length === 0,
    realErrors.length ? `consoleErrors=${JSON.stringify(realErrors.slice(0, 3))}` : (pageErrors.length ? `pageErrors=${pageErrors.slice(0, 2)}` : ''));
} catch (err) {
  console.error('浏览器流程异常:', err.message);
  failures++;
  try { await page.screenshot({ path: path.join(SHOTS, '99-failure.png') }); } catch { /* ignore */ }
} finally {
  await browser.close();
}

// ---------- 清理（API） ----------
console.log('\n=== 清理 ===');
try {
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: get('ADMIN_USERNAME'), password: get('ADMIN_PASSWORD') }),
  });
  const ld = await lr.json();
  const token = ld.accessToken;
  const csrf = ((lr.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('nd_csrf=')) || '').split(';')[0].split('=')[1] ?? '';
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrf, Cookie: 'nd_csrf=' + csrf };
  const GA = { Authorization: 'Bearer ' + token };
  const roots = await (await fetch(BASE + '/api/org/roots', { headers: GA })).json();
  const pr = roots.roots.find((r) => r.name === '我的空间').id;
  const list = await (await fetch(BASE + '/api/files?dirId=' + pr, { headers: GA })).json();
  const targets = list.items
    .filter((i) => i.name === 'e2e-big-30mb.bin' || i.name === 'e2e-note.txt')
    .map((i) => ({ type: i.type, id: i.id }));
  if (targets.length > 0) {
    await fetch(BASE + '/api/files/delete', { method: 'POST', headers: H, body: JSON.stringify({ targets }) });
    await fetch(BASE + '/api/files/purge', { method: 'POST', headers: H, body: JSON.stringify({ targets }) });
  }
  const trash = await (await fetch(BASE + '/api/files/trash', { headers: GA })).json();
  console.log('  清理完成，回收站剩余:', trash.items.length);
} catch (e) {
  console.log('  清理跳过:', e.message);
}

console.log('\n==============================');
console.log(failures === 0 ? '✅ 浏览器端到端验证全部通过' : `❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
