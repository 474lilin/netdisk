// 回收站：恢复 / 彻底删除 / 批量 / 清空回收站（分页循环，支持任意数量）
import { useCallback, useEffect, useState } from 'react';
import { Button, Space, message, Modal, Typography } from 'antd';
import { UndoOutlined, DeleteOutlined, ReloadOutlined, ClearOutlined } from '@ant-design/icons';
import { filesApi } from '../api';
import type { FileItem, TargetRef } from '../api/types';
import FileTable, { type FileAction } from '../components/FileTable';

export default function TrashPage() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 分页拉取：默认一页 2000（后端上限），返回 total 供全量清空判断
      const res = await filesApi.trash({ offset: 0, limit: 2000 });
      setItems(res.items);
      setTotal(res.total ?? res.items.length);
      setRetentionDays(res.retentionDays ?? 30);
      setSelectedKeys([]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toTargets = (list: FileItem[]): TargetRef[] => list.map((i) => ({ type: i.type, id: i.id }));
  const selected = items.filter((i) => selectedKeys.includes(i.id));

  // 批量接口单次上限 1000（服务端 purge 已放开）；分批串行执行，保证回收站任意数量可一次性操作
  const CHUNK = 1000;
  async function chunked<T>(fn: (chunk: T[]) => Promise<unknown>, list: T[]): Promise<void> {
    for (let i = 0; i < list.length; i += CHUNK) {
      await fn(list.slice(i, i + CHUNK));
    }
  }

  const batchRestore = async (): Promise<void> => {
    try {
      await chunked((t) => filesApi.restore(t), toTargets(selected));
      message.success('已恢复');
      void load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const batchPurge = (): void => {
    Modal.confirm({
      title: `彻底删除选中的 ${selected.length} 项？`,
      content: '彻底删除后不可恢复，且释放存储空间。',
      okText: '彻底删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          if (selected.some((i) => i.type === 'dir')) {
            message.info('正在彻底删除，大目录可能需要几分钟，请勿关闭页面');
          }
          await chunked((t) => filesApi.purge(t), toTargets(selected));
          message.success('已彻底删除');
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          void load();
        }
      },
    });
  };

  // 清空回收站：后端专用接口一次完成（服务端批量删对象+删行），前端只发一个请求
  const clearAll = (): void => {
    Modal.confirm({
      title: `清空回收站（共 ${total} 项）？`,
      content: '将彻底删除回收站中所有文件与目录，不可恢复。大回收站可能耗时较长，请勿关闭页面。',
      okText: '全部清空',
      okButtonProps: { danger: true },
      onOk: async () => {
        setClearing(true);
        const hide = message.loading('正在清空回收站…', 0);
        try {
          const res = await filesApi.emptyTrash();
          message.success(`已清空回收站（${res.count} 项）`);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          hide();
          setClearing(false);
          void load();
        }
      },
    });
  };

  const handleAction = async (action: FileAction, item: FileItem): Promise<void> => {
    if (action === 'restore') {
      try {
        await filesApi.restore(toTargets([item]));
        message.success('已恢复');
        void load();
      } catch (e) {
        message.error((e as Error).message);
      }
    } else if (action === 'purge') {
      Modal.confirm({
        title: `彻底删除「${item.name}」？`,
        content: '彻底删除后不可恢复。',
        okText: '彻底删除',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await filesApi.purge(toTargets([item]));
            message.success('已彻底删除');
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            void load();
          }
        },
      });
    }
  };

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          回收站
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            {total > 0 ? `共 ${total} 项` : ''}
            删除的文件保留 {retentionDays} 天后自动彻底清理
          </Typography.Text>
        </Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} />
          <Button icon={<UndoOutlined />} disabled={selected.length === 0 || clearing} onClick={() => void batchRestore()}>
            恢复
          </Button>
          <Button danger icon={<DeleteOutlined />} disabled={selected.length === 0 || clearing} onClick={() => void batchPurge()}>
            彻底删除
          </Button>
          <Button
            type="primary"
            danger
            icon={<ClearOutlined />}
            loading={clearing}
            disabled={total === 0}
            onClick={() => void clearAll()}
          >
            清空回收站
          </Button>
        </Space>
      </div>
      <FileTable
        items={items}
        loading={loading || clearing}
        selectedRowKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        onAction={(a, i) => void handleAction(a, i)}
        actions={['restore', 'purge']}
        emptyText="回收站为空"
      />
    </div>
  );
}
