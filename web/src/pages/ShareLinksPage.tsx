// 我的分享：管理分享链接（复制 / 撤销）
import { useCallback, useEffect, useState } from 'react';
import { Table, Button, Tag, message, Popconfirm, Space, Typography } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import { sharesApi } from '../api';
import type { ShareLink } from '../api/types';
import { formatTime } from '../utils/format';

export default function ShareLinksPage() {
  const [items, setItems] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sharesApi.list();
      setItems(res.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (url: string): Promise<void> => {
    const full = `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(full);
      message.success('链接已复制');
    } catch {
      window.prompt('复制链接', full);
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'targetName', ellipsis: true },
    {
      title: '类型',
      dataIndex: 'isDir',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="blue">目录</Tag> : <Tag>文件</Tag>),
    },
    {
      title: '密码',
      dataIndex: 'hasPassword',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="orange">有密码</Tag> : <Tag>无</Tag>),
    },
    {
      title: '有效期',
      dataIndex: 'expiresAt',
      width: 150,
      render: (v: string | null) => (v ? formatTime(v) : '永久'),
    },
    {
      title: '访问',
      width: 110,
      render: (_: unknown, r: ShareLink) => (r.maxAccessCount > 0 ? `${r.accessCount}/${r.maxAccessCount}` : `${r.accessCount} 次`),
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (v: string) => formatTime(v) },
    {
      title: '操作',
      width: 160,
      render: (_: unknown, r: ShareLink) => (
        <Space>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(r.url)}>
            复制
          </Button>
          <Popconfirm title="撤销后链接立即失效，确认？" onConfirm={() => void revoke(r.id)}>
            <Button size="small" danger>
              撤销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const revoke = async (id: string): Promise<void> => {
    await sharesApi.revoke(id);
    message.success('已撤销');
    void load();
  };

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        <LinkOutlined /> 我的分享
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          内网分享链接，可设密码 / 有效期 / 次数限制；请勿外传至公网
        </Typography.Text>
      </Typography.Title>
      <Table rowKey="id" size="middle" loading={loading} columns={columns} dataSource={items} pagination={{ pageSize: 20 }} />
    </div>
  );
}
