// 断点续传自动恢复（v1.1 第三轮 3.3；v1.1.16 起不再限制文件大小）：
// 页面加载时读取 IndexedDB 中未完成的续传记录——**只要记录里带着文件内容**就自动重新入队，
// 上传引擎命中记录后续传缺失分片（刷新浏览器不再导致上传失败，也不需要用户重新选择文件）。
// 审查加固（v1.1.1）：分批恢复（每批 50，让出主线程）——并发槽位由队列 pump 限流（≤6），
// 避免极端大批量（21k 全中断）同步循环阻塞主线程
import { useEffect, useRef } from 'react';
import { loadResumeRecords } from '../utils/resume-store';
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
        // 仅恢复「带文件内容」且未完成的会话（大小不限，由 resume-store 的存储预算决定是否留有内容）：
        //   - 分片会话（totalParts > 1）：续传缺失分片
        //   - 单请求直传已 PUT 待 complete（mode1Pending，v1.1.5）：直接补 complete，秒级完成
        const resumeable = records.filter((r) => r.file && (r.totalParts > 1 || r.mode1Pending));
        if (resumeable.length === 0) return;
        // 去重：同一文件只入队一次
        const seen = new Set<string>();
        // 任务列表里已存在同一文件的任务（刷新前的中断任务）→ 不再新建重复条目：
        // 这类任务由 hydrateTaskList 直接用 IndexedDB 里的 File 自动续传（v1.1.13），
        // 否则会出现「一个自动续传的新任务 + 一个失败的旧任务」两条记录。
        const existing = new Set(
          Object.values(useUploadStore.getState().tasks)
            .filter((t) => t.kind !== 'download' && t.status !== 'completed' && t.status !== 'dedup')
            .map((t) => `${t.dirId}\u0000${t.fileName}\u0000${t.size}`)
        );
        const unique = resumeable.filter((r) => {
          if (seen.has(r.key)) return false;
          seen.add(r.key);
          if (existing.has(`${r.dirId}\u0000${r.fileName}\u0000${r.size}`)) return false;
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
