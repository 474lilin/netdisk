// 系统文件选择框（v1.1.13）
// 用途：刷新/重开页面后，上传任务丢失了本地 File 引用（浏览器不允许把 File 持久化），
//       需要用户重新「选回」这些文件才能从断点继续上传。
// 说明：取消选择时 change 事件不会触发，用 window focus 兜底判定（对话框关闭即失焦回焦）。
export interface PickFilesOptions {
  /** 是否允许多选（默认 true） */
  multiple?: boolean;
  /** accept 过滤（如 ".zip,application/zip"）；留空表示不限 */
  accept?: string;
  /** 取消判定兜底时长（ms）：对话框关闭后若 500ms 内没有 change，视为取消 */
  cancelGraceMs?: number;
}

/**
 * 打开系统文件选择框，返回用户选中的文件；用户取消则返回空数组。
 * 注意：拿到的是「选择的那个文件」，不含原始相对路径。
 */
export function pickFiles(opts: PickFilesOptions = {}): Promise<File[]> {
  const multiple = opts.multiple ?? true;
  const grace = opts.cancelGraceMs ?? 500;
  return new Promise<File[]>((resolve) => {
    if (typeof document === 'undefined') {
      resolve([]);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (opts.accept) input.accept = opts.accept;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';
    input.setAttribute('aria-hidden', 'true');
    document.body.appendChild(input);

    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };
    const onFocus = (): void => {
      // 对话框已关闭：稍等片刻让 change 先到（选中文件时 change 先于/同时于 focus 触发）
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => finish(Array.from(input.files ?? [])), grace);
    };
    input.onchange = () => finish(Array.from(input.files ?? []));
    input.oncancel = () => finish([]); // 新版浏览器支持（Chrome 113+）
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
