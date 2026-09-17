// 主文件浏览页：列表 / 上传（含文件夹）/ 拖拽 / 下载 / 分享 / 权限 / 版本 / 移动复制 / 删除
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Space, Breadcrumb, Modal, Form, Input, message, Tooltip, Typography, Upload,
} from 'antd';
import {
  UploadOutlined, FolderAddOutlined, ReloadOutlined, DownloadOutlined, DeleteOutlined,
  CopyOutlined, DragOutlined, SearchOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { filesApi, orgApi } from '../api';
import type { FileItem, TargetRef } from '../api/types';
import FileTable, { type FileAction } from '../components/FileTable';
// 预览组件懒加载：pdfjs/xlsx/docx 等重型库仅在打开预览时加载，不进首屏
const FilePreview = lazy(() => import('../components/FilePreview'));
// 弹窗组件懒加载（打开时才加载对应 chunk，缩小首屏主包）
const ShareModal = lazy(() => import('../components/ShareModal'));
const PermissionModal = lazy(() => import('../components/PermissionModal'));
const VersionModal = lazy(() => import('../components/VersionModal'));
const MoveModal = lazy(() => import('../components/MoveModal'));
// 上传队列面板 / 登录过期恢复入口：已提升到 MainLayout 全站挂载（切页不中断）
import { useUploadStore } from '../store/upload';
import { useIsMobile } from '../utils/useMediaQuery';
import { getToken } from '../api/client';
import { downloadToFile } from '../utils/downloader';
import { warmupHash } from '../utils/hash';
import { useAutoResume } from '../hooks/useAutoResume';

// 超过该数量启用虚拟滚动（一次性渲染大量行会卡顿）
const VIRTUAL_THRESHOLD = 400;

export default function FileBrowserPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const dirId = searchParams.get('dirId') || '';

  // 预热 BLAKE3 WASM：避免首个文件上传时等待哈希引擎初始化
  useEffect(() => {
    const timer = setTimeout(() => warmupHash(), 500);
    return () => clearTimeout(timer);
  }, []);

  // 断点续传：页面加载自动恢复未完成任务（IndexedDB 中小文件带 File 引用）
  useAutoResume();

  const [items, setItems] = useState<FileItem[]>([]);
  const [dir, setDir] = useState<{ id: string; name: string; scope: number; path: string } | null>(null);
  const [rights, setRights] = useState<{ read: boolean; write: boolean; del: boolean; share: boolean }>({ read: false, write: false, del: false, share: false });
  const [crumbs, setCrumbs] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [dragging, setDragging] = useState(false);
  // 当前目录本地即时过滤（名称包含）
  const [filter, setFilter] = useState('');
  const PAGE_LIMIT = 500;

  // 弹窗
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [permFile, setPermFile] = useState<FileItem | null>(null);
  const [versionFile, setVersionFile] = useState<FileItem | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<'move' | 'copy'>('move');
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [renameForm] = Form.useForm();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const selectedItems = useMemo(() => selectedKeys.map((k) => itemMap.get(k as string)).filter(Boolean) as FileItem[], [selectedKeys, itemMap]);

  // 本地即时过滤（名称包含，目录/文件统一）；过滤后选择键失效的自动剔除
  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, filter]);
  useEffect(() => {
    const valid = new Set(filteredItems.map((i) => i.id));
    setSelectedKeys((keys) => keys.filter((k) => valid.has(k as string)));
  }, [filteredItems]);

  const load = useCallback(async () => {
    if (!dirId) return;
    setLoading(true);
    try {
      const [res, bd] = await Promise.all([filesApi.list(dirId, { offset: 0, limit: PAGE_LIMIT }), filesApi.breadcrumb(dirId)]);
      setItems(res.items);
      setTotal(res.total ?? res.items.length);
      setHasMore(res.hasMore ?? false);
      setDir(res.dir);
      setRights(res.rights);
      setCrumbs(bd.items);
      setSelectedKeys([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [dirId]);

  // 加载更多（追加下一页，虚拟滚动天然支持追加数据）
  const loadMore = useCallback(async () => {
    if (!dirId || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await filesApi.list(dirId, { offset: items.length, limit: PAGE_LIMIT });
      setItems((prev) => [...prev, ...res.items]);
      setTotal(res.total ?? 0);
      setHasMore(res.hasMore ?? false);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [dirId, items.length, loadingMore]);

  // 初始定位：无 dirId 时落到第一个根目录
  useEffect(() => {
    if (dirId) {
      void load();
      return;
    }
    orgApi.roots().then((r) => {
      if (r.roots.length > 0) navigate(`/?dirId=${r.roots[0].id}`, { replace: true });
    });
  }, [dirId, load, navigate]);

  // 上传完成后自动刷新（防抖合并 + 低频轮询）：1s 检查一次终态计数，避免每任务状态变化重渲染
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledCountRef = useRef(-1);
  useEffect(() => {
    const timer = setInterval(() => {
      const s = useUploadStore.getState();
      const tasks = Object.values(s.tasks);
      if (tasks.length === 0) return;
      let settled = 0;
      for (const t of tasks) {
        if (t.status === 'completed' || t.status === 'dedup' || t.status === 'error') settled++;
      }
      if (settled === settledCountRef.current) return;
      settledCountRef.current = settled;
      // 防抖：500ms 内多个任务完成只触发一次刷新（等 complete 全部落库）
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => void load(), 500);
    }, 1000);
    return () => {
      clearInterval(timer);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [load]);

  const toTargets = (list: FileItem[]): TargetRef[] => list.map((i) => ({ type: i.type, id: i.id }));

  // 批量接口单次上限 100（后端防滥用）：分批串行执行，保证任意数量可一次性操作
  const CHUNK = 100;
  async function chunkedTargets(fn: (t: TargetRef[]) => Promise<unknown>, list: TargetRef[]): Promise<void> {
    for (let i = 0; i < list.length; i += CHUNK) {
      await fn(list.slice(i, i + CHUNK));
    }
  }

  // ---------- 上传（含文件夹路径保持） ----------
  // 目录并行创建：收集全部目录路径按深度分层，同层并行 mkdir（限流），全部就绪后一次性入队
  // （此前逐组串行 mkdir：3195 个目录组导致队列长期空转，上传速率被目录创建拖垮）
  const mkdirParallelLimit = 12;

  const prepareUploads = async (files: File[], baseDirId: string): Promise<void> => {
    // 1) 收集目录路径（去重）
    const dirPaths = new Set<string>();
    const fileGroups = new Map<string, File[]>();
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      const idx = rel.lastIndexOf('/');
      const parentPath = idx > 0 ? rel.slice(0, idx) : '';
      fileGroups.set(parentPath, [...(fileGroups.get(parentPath) ?? []), f]);
      // 该文件的所有祖先目录
      if (parentPath) {
        const segs = parentPath.split('/');
        let acc = '';
        for (const seg of segs) {
          acc = acc ? `${acc}/${seg}` : seg;
          dirPaths.add(acc);
        }
      }
    }
    // 2) 按深度分层（浅层先建，保证父目录先于子目录）
    const byDepth = new Map<number, string[]>();
    for (const p of dirPaths) {
      const depth = p.split('/').length;
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), p]);
    }
    const depthOrder = [...byDepth.keys()].sort((a, b) => a - b);
    // 3) 并行创建目录（限流）；path -> dirId 映射
    const dirIdByPath = new Map<string, string>();
    let dirFailCount = 0;
    for (const depth of depthOrder) {
      const paths = byDepth.get(depth)!;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const p = paths[cursor++];
          if (p === undefined) return;
          const idx = p.lastIndexOf('/');
          const parentId = idx < 0 ? baseDirId : dirIdByPath.get(p.slice(0, idx));
          const seg = idx < 0 ? p : p.slice(idx + 1);
          if (!parentId) { dirFailCount++; return; }
          try {
            const d = await filesApi.mkdir(parentId, seg);
            dirIdByPath.set(p, d.id);
          } catch (e) {
            const err = e as Error;
            if (/已存在/.test(err.message)) {
              const res = await filesApi.list(parentId);
              const found = res.items.find((i) => i.type === 'dir' && i.name === seg);
              if (found) dirIdByPath.set(p, found.id);
              else { dirFailCount++; console.error(`[mkdir] 已存在但未找到: ${p}`, err.message); }
            } else {
              dirFailCount++;
              console.error(`[mkdir] 失败: ${p} parent=${parentId}`, err.message);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(mkdirParallelLimit, paths.length) }, () => worker()));
    }
    // 4) 全部目录就绪后一次性入队（队列满负载运行；失败组的文件跳过并提示）
    let skipped = 0;
    for (const [path, list] of fileGroups) {
      const dirIdNow = path ? dirIdByPath.get(path) : baseDirId;
      if (!dirIdNow) { skipped += list.length; continue; }
      useUploadStore.getState().addFiles(list, dirIdNow);
    }
    if (dirFailCount > 0 || skipped > 0) {
      message.warning(`${dirFailCount} 个目录创建失败，${skipped} 个文件未加入队列`);
    }
  };

  const onFilesSelected = (fileList: File[]): void => {
    if (!dirId) return;
    void prepareUploads(fileList, dirId);
  };

  const collectDropped = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragging(false);
    if (!dirId || !e.dataTransfer?.items) return;
    const files: File[] = [];
    const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
        const full = path ? `${path}/${file.name}` : file.name;
        Object.defineProperty(file, 'webkitRelativePath', { value: full });
        files.push(file);
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const reader = dirEntry.createReader();
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          const all: FileSystemEntry[] = [];
          const readBatch = (): void => {
            reader.readEntries((batch) => {
              if (batch.length === 0) resolve(all);
              else {
                all.push(...batch);
                readBatch();
              }
            }, reject);
          };
          readBatch();
        });
        for (const child of entries) {
          await walk(child, path ? `${path}/${dirEntry.name}` : dirEntry.name);
        }
      }
    };
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) await walk(entry, '');
    }
    if (files.length > 0) await prepareUploads(files, dirId);
  };

  // ---------- 操作 ----------
  const handleAction = async (action: FileAction, item: FileItem): Promise<void> => {
    switch (action) {
      case 'download': {
        // v1.1.10：下载也进「上传/下载任务列表」，带进度、可取消/重试
        if (item.type === 'dir') {
          // 文件夹：后端 zip 流式打包下载（鉴权接口，前端流式读取存 Blob 保存）
          const zipName = `${item.name}.zip`;
          useUploadStore.getState().addDownload({
            name: zipName,
            size: item.size ?? 0,
            dirId: dirId ?? undefined,
            fileId: item.id,
            isDir: true,
            run: (ctx) =>
              downloadToFile(`/api/files/${item.id}/download-dir`, ctx, {
                fileName: zipName,
                headers: { Authorization: 'Bearer ' + getToken() },
                jsonError: true,
              }),
          });
          break;
        }
        try {
          const res = await filesApi.download(item.id);
          useUploadStore.getState().addDownload({
            name: item.name,
            size: item.size ?? 0,
            dirId: dirId ?? undefined,
            fileId: item.id,
            run: (ctx) => downloadToFile(res.url, ctx, { fileName: item.name, knownSize: item.size ?? 0 }),
          });
        } catch (e) {
          message.error((e as Error).message);
        }
        break;
      }
      case 'share':
        setShareFile(item);
        break;
      case 'versions':
        setVersionFile(item);
        break;
      case 'permission':
        setPermFile(item);
        break;
      case 'rename':
        setRenameTarget(item);
        renameForm.setFieldsValue({ name: item.name });
        break;
      case 'delete': {
        Modal.confirm({
          title: `删除「${item.name}」？`,
          content: item.type === 'dir' ? '将连同其全部内容移入回收站，可在回收站恢复。' : '文件将移入回收站，可在回收站恢复。',
          okText: '删除',
          okButtonProps: { danger: true },
          onOk: async () => {
            await filesApi.remove(toTargets([item]));
            message.success('已移入回收站');
            void load();
          },
        });
        break;
      }
      case 'copy':
        setMoveMode('copy');
        setSelectedKeys([item.id]);
        setMoveOpen(true);
        break;
      case 'move':
        setMoveMode('move');
        setSelectedKeys([item.id]);
        setMoveOpen(true);
        break;
      case 'restore':
      case 'purge':
        break;
    }
  };

  const batchDelete = (): void => {
    if (selectedItems.length === 0) return;
    Modal.confirm({
      title: `删除选中的 ${selectedItems.length} 个项目？`,
      content: '将移入回收站，可在回收站恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await chunkedTargets((t) => filesApi.remove(t), toTargets(selectedItems));
          message.success('已移入回收站');
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          void load();
        }
      },
    });
  };

  const batchMove = (mode: 'move' | 'copy'): void => {
    if (selectedItems.length === 0) return;
    setMoveMode(mode);
    setMoveOpen(true);
  };

  const doMove = async (targetDirId: string): Promise<void> => {
    try {
      if (moveMode === 'move') await chunkedTargets((t) => filesApi.move(t, targetDirId), toTargets(selectedItems));
      else await chunkedTargets((t) => filesApi.copy(t, targetDirId), toTargets(selectedItems));
      message.success(moveMode === 'move' ? '移动完成' : '复制完成');
      setMoveOpen(false);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doRename = async (): Promise<void> => {
    if (!renameTarget) return;
    const values = await renameForm.validateFields();
    try {
      await filesApi.rename(renameTarget.id, renameTarget.type, values.name);
      message.success('重命名成功');
      setRenameTarget(null);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // ---------- 渲染 ----------
  const uploadProps: UploadProps = {
    showUploadList: false,
    multiple: true,
    beforeUpload: (file) => {
      // 注意：rc-upload 对每个文件触发一次 beforeUpload，且 fileList 为整批文件。
      // 若传入 fileList 会把整批重复入队（N 个文件 -> N² 个任务，队列爆炸）。
      // 因此每次只入队当前这一个文件（N 个文件 -> N 个任务）。
      onFilesSelected([file]);
      return false;
    },
  };

  return (
    <div
      style={{ background: '#fff', borderRadius: 8, padding: 16, minHeight: 'calc(100vh - 120px)' }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => void collectDropped(e)}
    >
      {dragging && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(22,119,255,0.12)',
            border: '2px dashed #1677ff', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Typography.Title level={3} style={{ color: '#1677ff' }}>松开以上传（支持文件夹）</Typography.Title>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Breadcrumb
          items={crumbs.map((c) => ({ title: c.name }))}
        />
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: 'rgba(0,0,0,0.25)' }} />}
            placeholder="过滤当前目录"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: isMobile ? '100%' : 180 }}
          />
          <Upload {...uploadProps} disabled={!rights.write}>
            <Button type="primary" icon={<UploadOutlined />} disabled={!rights.write}>
              上传文件
            </Button>
          </Upload>
          <Button icon={<FolderAddOutlined />} disabled={!rights.write} onClick={() => folderInputRef.current?.click()}>
            上传文件夹
          </Button>
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length > 0) onFilesSelected(list);
              e.target.value = '';
            }}
            {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          />
          <Button
            icon={<FolderAddOutlined />}
            disabled={!rights.write}
            onClick={() => {
              Modal.confirm({
                title: '新建文件夹',
                content: (
                  <Input
                    id="new-folder-name"
                    placeholder="文件夹名称"
                    maxLength={255}
                    autoFocus
                    onPressEnter={(e) => {
                      void (async () => {
                        const name = (e.target as HTMLInputElement).value.trim();
                        if (!name) {
                          message.warning('请输入文件夹名称');
                          return;
                        }
                        try {
                          await filesApi.mkdir(dirId, name);
                          message.success('已创建');
                          Modal.destroyAll();
                          void load();
                        } catch (err) {
                          message.error((err as Error).message);
                        }
                      })();
                    }}
                  />
                ),
                onOk: () => {
                  const input = document.getElementById('new-folder-name') as HTMLInputElement | null;
                  const name = input?.value?.trim() ?? '';
                  if (!name) {
                    message.warning('请输入文件夹名称');
                    return Promise.reject();
                  }
                  return filesApi
                    .mkdir(dirId, name)
                    .then(() => {
                      message.success('已创建');
                      void load();
                    })
                    .catch((e) => {
                      message.error((e as Error).message);
                      throw e;
                    });
                },
              });
            }}
          >
            新建文件夹
          </Button>
          <Tooltip title="刷新列表">
            <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          </Tooltip>
          <Tooltip title={selectedItems.length !== 1 ? '仅支持选中单个文件下载（文件夹请用操作菜单打包下载）' : '下载选中文件'}>
            <Button
              icon={<DownloadOutlined />}
              disabled={!(selectedItems.length === 1 && selectedItems[0].type === 'file')}
              onClick={() => {
                if (selectedItems.length === 1 && selectedItems[0].type === 'file') {
                  void handleAction('download', selectedItems[0]);
                }
              }}
            />
          </Tooltip>
          <Tooltip title="移动到">
            <Button icon={<DragOutlined />} disabled={selectedItems.length === 0 || !rights.write} onClick={() => batchMove('move')} />
          </Tooltip>
          <Tooltip title="复制到">
            <Button icon={<CopyOutlined />} disabled={selectedItems.length === 0 || !rights.write} onClick={() => batchMove('copy')} />
          </Tooltip>
          <Tooltip title="移入回收站（可恢复）">
            <Button danger icon={<DeleteOutlined />} disabled={selectedItems.length === 0 || !rights.del} onClick={() => void batchDelete()}>
              删除
            </Button>
          </Tooltip>
        </Space>
      </div>

      {filter.trim() && (
        <div style={{ marginBottom: 8, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
          当前仅在已加载的 {items.length} 项中过滤
          {hasMore && '（未加载部分需点击"加载更多"后匹配）'}
        </div>
      )}
      <FileTable
        items={filteredItems}
        loading={loading}
        selectedRowKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        onOpenDir={(item) => navigate(`/?dirId=${item.id}`)}
        onPreview={(item) => setPreviewFile(item)}
        onAction={(a, i) => void handleAction(a, i)}
        actions={['download', 'share', 'versions', 'permission', 'rename', 'copy', 'move', 'delete']}
        showOwner
        virtual={filteredItems.length > VIRTUAL_THRESHOLD}
        emptyText={filter.trim() ? '未找到匹配的文件或文件夹' : undefined}
      />
      {hasMore && !filter.trim() && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ marginRight: 12, fontSize: 12 }}>
            已显示 {items.length} / {total} 项
          </Typography.Text>
          <Button loading={loadingMore} onClick={() => void loadMore()}>
            加载更多
          </Button>
        </div>
      )}

      {/* 弹窗（lazy 组件局部 Suspense：chunk 加载瞬间显示空，避免整页 fallback） */}
      <Suspense fallback={null}>
        <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
        <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
        <PermissionModal target={permFile} onClose={() => setPermFile(null)} />
        <VersionModal file={versionFile} onClose={() => setVersionFile(null)} onRollback={() => void load()} />
        <MoveModal open={moveOpen} mode={moveMode} onCancel={() => setMoveOpen(false)} onConfirm={(t) => doMove(t)} />
      </Suspense>
      <Modal open={!!renameTarget} onCancel={() => setRenameTarget(null)} onOk={() => void doRename()} title="重命名" destroyOnHidden>
        <Form form={renameForm}>
          <Form.Item name="name" rules={[{ required: true, message: '请输入新名称' }]}>
            <Input maxLength={255} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
