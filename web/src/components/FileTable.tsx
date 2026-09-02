// 通用文件表格：名称/大小/所有者/时间 + 选择 + 操作菜单（图片项显示懒加载缩略图）
import { Table, Dropdown, Button, Typography } from 'antd';
import {
  FolderFilled,
  FileFilled,
  MoreOutlined,
  DownloadOutlined,
  ShareAltOutlined,
  HistoryOutlined,
  LockOutlined,
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  DragOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { FileItem } from '../api/types';
import { getCategory, getPreviewKind } from '../utils/constants';
import { formatSize, formatTime } from '../utils/format';
import ThumbImg from './ThumbImg';
import { useIsMobile } from '../utils/useMediaQuery';

export type FileAction =
  | 'download'
  | 'share'
  | 'versions'
  | 'permission'
  | 'rename'
  | 'delete'
  | 'copy'
  | 'move'
  | 'restore'
  | 'purge';

const ACTION_ICONS: Partial<Record<FileAction, React.ReactNode>> = {
  download: <DownloadOutlined />,
  share: <ShareAltOutlined />,
  versions: <HistoryOutlined />,
  permission: <LockOutlined />,
  rename: <EditOutlined />,
  delete: <DeleteOutlined />,
  copy: <CopyOutlined />,
  move: <DragOutlined />,
  restore: <UndoOutlined />,
  purge: <DeleteOutlined />,
};

const ACTION_LABELS: Record<FileAction, string> = {
  download: '下载',
  share: '分享',
  versions: '版本管理',
  permission: '权限',
  rename: '重命名',
  delete: '删除',
  copy: '复制到',
  move: '移动到',
  restore: '恢复',
  purge: '彻底删除',
};

interface FileTableProps {
  items: FileItem[];
  loading?: boolean;
  selectedRowKeys?: React.Key[];
  onSelectionChange?: (keys: React.Key[]) => void;
  onOpenDir?: (item: FileItem) => void;
  onPreview?: (item: FileItem) => void;
  onAction?: (action: FileAction, item: FileItem) => void;
  actions?: FileAction[];
  showOwner?: boolean;
  emptyText?: string;
  selectable?: boolean;
  /** 大目录（超过阈值）启用虚拟滚动，避免一次性渲染大量行 */
  virtual?: boolean;
  /** 图片项显示懒加载缩略图（需登录获取预览 URL）；分享页等无登录场景应关闭 */
  showThumbs?: boolean;
}

export default function FileTable({
  items,
  loading,
  selectedRowKeys,
  onSelectionChange,
  onOpenDir,
  onPreview,
  onAction,
  actions = [],
  showOwner = false,
  emptyText = '暂无文件，点击"上传"或拖拽文件到此处',
  selectable = true,
  virtual = false,
  showThumbs = true,
}: FileTableProps) {
  const isMobile = useIsMobile();
  const columns: ColumnsType<FileItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      // 虚拟滚动要求列宽明确；非虚拟时自适应（ellipsis）
      ...(virtual ? { width: isMobile ? 180 : 380 } : {}),
      ellipsis: true,
      sorter: (a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1),
      defaultSortOrder: 'ascend',
      render: (_, item) => {
        const cat = getCategory(item.name);
        const isImage = showThumbs && item.type === 'file' && getPreviewKind(item.name) === 'image';
        return (
          <div
            className="file-name-cell"
            onClick={() => {
              if (item.type === 'dir') onOpenDir?.(item);
              else onPreview?.(item);
            }}
          >
            {item.type === 'dir' ? (
              <FolderFilled style={{ color: '#faad14', fontSize: 18 }} />
            ) : isImage ? (
              <ThumbImg fileId={item.id} />
            ) : (
              <FileFilled style={{ color: cat.color, fontSize: 18 }} />
            )}
            <span className="name-text">{item.name}</span>
          </div>
        );
      },
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: isMobile ? 90 : 110,
      sorter: (a, b) => (a.type === 'dir' ? -1 : a.size ?? 0) - (b.type === 'dir' ? -1 : b.size ?? 0),
      render: (v: number | undefined, item) => (item.type === 'dir' ? '-' : formatSize(v)),
    },
    // 移动端隐藏"所有者/更新时间"，保留名称+大小+操作
    ...(showOwner && !isMobile
      ? [{ title: '所有者', dataIndex: 'ownerName', width: 130, render: (v?: string) => v || '-' }]
      : []),
    ...(!isMobile
      ? [
          {
            title: '更新时间',
            dataIndex: 'updatedAt',
            width: 160,
            sorter: (a: FileItem, b: FileItem) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
            render: (v: string) => formatTime(v),
          },
        ]
      : []),
    ...(actions.length > 0
      ? [
          {
            title: '操作',
            width: 80,
            fixed: 'right' as const,
            render: (_: unknown, item: FileItem) => {
              const menuItems = actions
                .filter((a) => {
                  if (item.type === 'dir' && a === 'download' && !item.canWrite) return false;
                  if (a === 'delete' && item.canDelete === false) return false;
                  if (a === 'permission' && item.canShare === false) return false;
                  if (a === 'share' && item.canShare === false) return false;
                  if ((a === 'rename' || a === 'copy' || a === 'move') && item.canWrite === false) return false;
                  return true;
                })
                .map((a) => ({
                  key: a,
                  icon: ACTION_ICONS[a],
                  label: ACTION_LABELS[a],
                  danger: a === 'delete' || a === 'purge',
                }));
              return (
                <Dropdown
                  menu={{
                    items: menuItems,
                    onClick: ({ key }) => onAction?.(key as FileAction, item),
                  }}
                  trigger={['click']}
                >
                  <Button type="text" size="small" icon={<MoreOutlined />} />
                </Dropdown>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <Table<FileItem>
      rowKey={(r) => r.id}
      size="middle"
      loading={loading}
      columns={columns}
      dataSource={items}
      pagination={false}
      rowSelection={
        selectable
          ? {
              selectedRowKeys,
              onChange: onSelectionChange,
            }
          : undefined
      }
      locale={{ emptyText: <Typography.Text type="secondary">{emptyText}</Typography.Text> }}
      // 虚拟滚动：rc-table 要求 scroll.x/y 为数字且每列有明确宽度（antd 5.9+）
      {...(virtual
        ? { virtual: true, scroll: { y: isMobile ? 420 : 520, x: isMobile ? 380 : showOwner ? 1080 : 950 } }
        : {})}
      onRow={(item) => ({
        onDoubleClick: () => {
          if (item.type === 'dir') onOpenDir?.(item);
        },
      })}
    />
  );
}
