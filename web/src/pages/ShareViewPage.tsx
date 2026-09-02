// 分享访问页（公开 token，内网链接；支持密码验证、目录浏览、单文件下载）
import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Card, Spin, Result, Button, Input, Space, Typography, Tag, message, Breadcrumb } from 'antd';
import { LockOutlined, DownloadOutlined, FolderOutlined } from '@ant-design/icons';
import { sharesApi } from '../api';
import type { FileItem, ShareMeta } from '../api/types';
import FileTable from '../components/FileTable';
import { formatSize } from '../utils/format';

export default function ShareViewPage() {
  const { token = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const dirId = params.get('dirId') || '';

  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkError, setNetworkError] = useState(false);
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [items, setItems] = useState<FileItem[]>([]);
  const [current, setCurrent] = useState<FileItem | null>(null);
  const [crumbs, setCrumbs] = useState<FileItem[]>([]);
  const [downloading, setDownloading] = useState(false);

  const loadMeta = useCallback(async () => {
    setLoading(true);
    try {
      const m = await sharesApi.meta(token);
      setMeta(m);
      // 独立分享页：无登录态，设置页面标题为分享名（默认企业网盘）
      if (m.valid && m.name) document.title = `${m.name} - 分享 | 企业网盘`;
      if (m.valid && !m.needPassword) {
        setUnlocked(true);
        if (m.isDir) await loadDir('');
      }
    } catch (e) {
      // 网络/服务错误 ≠ 分享无效：区分展示，避免断网时误报"分享不存在"
      const err = e as { code?: string; message?: string };
      if (err?.code === 'NETWORK' || err?.code === 'TIMEOUT' || /网络|超时/.test(err?.message || '')) {
        setNetworkError(true);
        setLoading(false);
        return;
      }
      setMeta({ valid: false, needPassword: false });
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadDir = async (dirIdNow: string): Promise<void> => {
    const res = await sharesApi.listDir(token, { dirId: dirIdNow || undefined, password: password || undefined });
    setItems(res.items);
    setCurrent(res.current);
    // 祖先链（分享根 → 当前目录）+ 当前目录：可点击返回任意上级
    setCrumbs([...(res.ancestors ?? []), ...(res.current ? [res.current] : [])]);
  };

  useEffect(() => {
    void loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (unlocked && meta?.isDir) {
      void loadDir(dirId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirId, unlocked]);

  const unlock = async (): Promise<void> => {
    try {
      const m = await sharesApi.meta(token);
      if (m.valid && m.needPassword) {
        // 用一次下载尝试校验密码
        if (m.isDir) {
          await sharesApi.listDir(token, { dirId: undefined, password });
        } else {
          await sharesApi.download(token, password);
        }
      }
      setUnlocked(true);
      setMeta(m);
      if (m.isDir) await loadDir('');
      message.success('验证通过');
    } catch (e) {
      message.error((e as Error).message || '密码错误');
    }
  };

  const downloadFile = async (): Promise<void> => {
    try {
      const res = await sharesApi.download(token, password || undefined);
      window.open(res.url, '_blank');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (networkError) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <Card style={{ width: '100%', maxWidth: 420 }}>
          <Result
            status="error"
            title="网络连接失败"
            subTitle="请检查网络后刷新重试"
            extra={
              <Button type="primary" onClick={() => { setNetworkError(false); void loadMeta(); }}>
                重试
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (!meta?.valid) {
    const reason = meta?.expired ? '该分享已过期' : meta?.revoked ? '该分享已被撤销' : meta?.countReached ? '该分享访问次数已达上限' : '分享不存在或已失效';
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <Card style={{ width: '100%', maxWidth: 420 }}>
          <Result status="warning" title={reason} subTitle="请联系分享者重新生成链接" />
        </Card>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
        <Card style={{ width: '100%', maxWidth: 420 }}>
          <div style={{ textAlign: 'center', fontSize: 32, color: '#faad14', marginBottom: 8 }}>
            <LockOutlined />
          </div>
          <Typography.Title level={5} style={{ textAlign: 'center' }}>
            {meta.name}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ textAlign: 'center', fontSize: 12 }}>
            该分享已加密，请输入访问密码
          </Typography.Paragraph>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              placeholder="访问密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onPressEnter={() => void unlock()}
            />
            <Button type="primary" onClick={() => void unlock()}>
              验证
            </Button>
          </Space.Compact>
        </Card>
      </div>
    );
  }

  // 目录分享内下载单文件（无登录态，走公开下载接口）
  const downloadDirFile = async (item: FileItem): Promise<void> => {
    setDownloading(true);
    try {
      const res = await sharesApi.download(token, password || undefined, item.id);
      window.open(res.url, '_blank');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  // 目录分享
  if (meta.isDir) {
    return (
      <div style={{ background: '#fff', minHeight: '100vh', padding: 24 }}>
        <Card>
          <Space style={{ marginBottom: 8 }}>
            <FolderOutlined style={{ fontSize: 20, color: '#faad14' }} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              {current?.name ?? meta.name}
            </Typography.Title>
            {meta.ownerName && <Tag>分享者：{meta.ownerName}</Tag>}
          </Space>
          {crumbs.length > 0 && (
            <Breadcrumb
              style={{ marginBottom: 8 }}
              items={crumbs.map((c, idx) => ({
                title:
                  idx === crumbs.length - 1 ? (
                    c.name
                  ) : (
                    <a
                      onClick={(e) => {
                        e.preventDefault();
                        setParams((prev) => {
                          const next = new URLSearchParams(prev);
                          if (idx === 0) next.delete('dirId');
                          else next.set('dirId', c.id);
                          return next;
                        });
                      }}
                    >
                      {c.name}
                    </a>
                  ),
              }))}
            />
          )}
          <FileTable
            items={items}
            selectable={false}
            emptyText="该目录为空"
            showThumbs={false}
            onOpenDir={(item) => {
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('dirId', item.id);
                return next;
              });
            }}
            onAction={(action, item) => {
              if (action === 'download' && item.type === 'file') void downloadDirFile(item);
            }}
            actions={['download']}
          />
        </Card>
      </div>
    );
  }

  // 单文件分享
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5' }}>
      <Card style={{ width: '100%', maxWidth: 460 }} title={meta.name}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">大小：{formatSize(meta.size)}</Typography.Text>
          <Typography.Text type="secondary">分享者：{meta.ownerName || '-'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            创建于 {meta.createdAt ? new Date(meta.createdAt).toLocaleString() : '-'}
          </Typography.Text>
          <Button
            type="primary"
            size="large"
            block
            icon={<DownloadOutlined />}
            disabled={meta.allowDownload === false}
            onClick={() => void downloadFile()}
          >
            {meta.allowDownload === false ? '分享者已禁止下载' : '下载文件'}
          </Button>
        </Space>
      </Card>
    </div>
  );
}
