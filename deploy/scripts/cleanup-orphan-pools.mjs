// 收尾清理 v2：孤儿去重池清理（JS 侧匹配，避免 shell 引号问题）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Client } from '../../server/node_modules/minio/dist/esm/minio.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
const get = (k) => (env.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
const DRY_RUN = process.argv.includes('--dry-run');

const client = new Client({
  endPoint: '127.0.0.1', port: 9000, useSSL: false,
  accessKey: get('MINIO_ROOT_USER'), secretKey: get('MINIO_ROOT_PASSWORD'),
});
const bucket = get('MINIO_BUCKET') || 'netdisk-data';

const q = (sql) => execSync(`docker exec netdisk-postgres psql -U netdisk -d netdisk -t -A -F"|" -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 }).trim();

// 所有池 + 所有被引用的池 key
const pools = q('SELECT org_id || chr(47) || chr(95) || chr(100) || chr(101) || chr(100) || chr(117) || chr(112) || chr(47) || sha256 || chr(124) || sha256 || chr(124) || size_bytes FROM dedup_pool;')
  .split('\n').filter(Boolean)
  .map((l) => { const [poolKey, sha256, size] = l.split('|'); return { poolKey, sha256, size_bytes: Number(size) }; });
const referenced = new Set(
  q(`SELECT object_key FROM files WHERE object_key LIKE chr(37) || chr(95) || chr(100) || chr(101) || chr(100) || chr(117) || chr(112) || chr(37);`)
    .split('\n').filter(Boolean)
);
const orphans = pools.filter((p) => !referenced.has(p.poolKey));
const totalGB = orphans.reduce((s, r) => s + r.size_bytes, 0) / 1024 / 1024 / 1024;
console.log(`池总数 ${pools.length}, 被引用 ${pools.length - orphans.length}, 孤儿 ${orphans.length} 个, 共 ${totalGB.toFixed(2)} GB${DRY_RUN ? '（DRY-RUN）' : ''}`);

if (!DRY_RUN) {
  let removed = 0, failed = 0;
  for (const r of orphans) {
    try {
      await client.removeObject(bucket, r.poolKey);
      execSync(`docker exec netdisk-postgres psql -U netdisk -d netdisk -c "DELETE FROM dedup_pool WHERE sha256 = '${r.sha256}';"`, { stdio: 'ignore' });
      removed++;
    } catch (e) {
      failed++;
      if (failed <= 3) console.log(`  失败 ${r.sha256.slice(0, 12)}: ${e.message.slice(0, 60)}`);
    }
    if (removed % 100 === 0 && removed > 0) console.log(`  已删 ${removed}/${orphans.length} ...`);
  }
  console.log(`完成: 删除 ${removed}, 失败 ${failed}`);
}
process.exit(0);
