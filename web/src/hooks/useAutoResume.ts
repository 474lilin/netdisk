// 断点续传自动恢复（v1.1 第三轮 3.3）：
// 页面加载时读取 IndexedDB 中未完成的续传记录——小文件（带 File 引用）自动重新入队，
// 上传引擎会命中 IndexedDB 记录续传（不重新上传已传分片）
// 审查加固（v1.1.1）：分批恢复（每批 50，让出主线程）——并发槽位由队列 pump 限流（≤6），
// 避免极端大批量（21k 全中断）同步循环阻塞主线程
import { useEffect, useRef } from 'react';
import { loadResumeRecords, FILE_PERSIST_LIMIT } from '../utils/resume-store';
import { useUploadStore } from '../store/upload';

const BATCH_SIZE = 50;

export function useAutoResume(): void {
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    void (async () => {
      try {
        const records = await loadResumeRecords();
        // 仅恢复带 File 引用（小文件）且未完成的会话：
        //   - 分片会话（totalParts > 1）：续传缺失分片
        //   - 单请求直传已 PUT 待 complete（mode1Pending，v1.1.5）：直接补 complete，秒级完成
        const resumeable = records.filter(
          (r) => r.file && r.size <= FILE_PERSIST_LIMIT && (r.totalParts > 1 || r.mode1Pending)
        );
        if (resumeable.length === 0) return;
        // 去重：同一文件只入队一次
        const seen = new Set<string>();
        const unique = resumeable.filter((r) => {
          if (seen.has(r.key)) return false;
          seen.add(r.key);
          return true;
        });
        let restored = 0;
        // 分批恢复：每批 50 个入队后让出事件循环（上传队列 pump 自动填满并发槽并限流）
        for (let i = 0; i < unique.length; i += BATCH_SIZE) {
          const batch = unique.slice(i, i + BATCH_SIZE);
          for (const rec of batch) {
            const f = rec.file as File;
            if (!f) continue;
            useUploadStore.getState().addFiles([f], rec.dirId);
            restored += 1;
          }
          if (i + BATCH_SIZE < unique.length) {
            await new Promise((r) => setTimeout(r, 0)); // 让出主线程
          }
        }
        if (restored > 0) {
          console.warn(`[auto-resume] 恢复 ${restored} 个未完成任务`);
        }
      } catch {
        /* IndexedDB 不可用则跳过自动恢复 */
      }
    })();
  }, []);
}
