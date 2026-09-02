// 页面可见性检测：切回前台时主动检查 Token 状态（v1.0.13）
// 后台定时器被浏览器节流（Chrome 后台 1s 限频），不依赖其精度；切回前台立即检测
import { useEffect } from 'react';
import { checkTokenOnVisible } from '../utils/token-refresh';

export function useVisibilityCheck(): void {
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        checkTokenOnVisible();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
}
