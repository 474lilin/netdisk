// 图片缩略图（懒加载）：进入视口才请求预览 URL（IntersectionObserver），URL 按文件缓存（约 1h 过期）
// 用于大目录列表：可视行才发预览请求，滚动不卡顿
import { useEffect, useRef, useState } from 'react';
import { FileFilled } from '@ant-design/icons';
import { filesApi } from '../api';

const URL_TTL = 55 * 60 * 1000; // 预览签名 URL 有效期 1h，提前 5 分钟失效
const urlCache = new Map<string, { url: string; ts: number }>();

interface Props {
  fileId: string;
  size?: number;
}

export default function ThumbImg({ fileId, size = 40 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cached = urlCache.get(fileId);
    if (cached && Date.now() - cached.ts < URL_TTL) {
      setSrc(cached.url);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    // 懒加载：进入视口（含预加载 rootMargin）才请求预览 URL
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        io.disconnect();
        void filesApi
          .preview(fileId)
          .then((r) => {
            if (cancelled) return;
            urlCache.set(fileId, { url: r.url, ts: Date.now() });
            setSrc(r.url);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [fileId]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        width={size}
        height={size}
        style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #f0f0f0', flexShrink: 0 }}
        onError={() => setFailed(true)}
      />
    );
  }
  // 未进入视口 / 加载中 / 失败：占位图标
  return (
    <div ref={ref} style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <FileFilled style={{ color: 'rgba(0,0,0,0.25)', fontSize: 20 }} />
    </div>
  );
}
