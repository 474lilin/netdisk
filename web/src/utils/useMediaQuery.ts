// 响应式：媒体查询 hook（SSR 安全；变化时自动更新）
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatch(e.matches);
    setMatch(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** 移动端（<768px）：侧边栏折叠、精简表格列、全宽抽屉等 */
export const useIsMobile = (): boolean => useMediaQuery('(max-width: 768px)');
