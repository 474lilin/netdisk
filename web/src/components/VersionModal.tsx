// 版本管理弹窗：历史版本列表 + 回滚（MinIO 对象版本控制）
import { useCallback, useEffect, useState } from 'react';
import { Modal, Table, Button, message, Popconfirm, Tag, Typography } from 'antd';
import { RollbackOutlined } from '@ant-design/icons';
import { filesApi } from '../api';
import type { FileItem, FileVersion } from '../api/types';
import { formatSize, formatTime } from '../utils/format';

interface Props {
  file: FileItem | null;
  onClose: () => void;
  onRollback?: () => void;
}

export default function VersionModal({ file, onClose, onRollback }: Props) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [rolling, setRolling] = useState('');

  const load = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    try {
      const res = await filesApi.versions(file.id);
      setVersions(res.versions);
      setCurrentVersion(res.current.versionId ?? '');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [file]);

  useEffect(() => {
    void load();
  }, [load]);

  const rollback = async (versionId: string): Promise<void> => {
    if (!file || rolling) return;
    setRolling(versionId);
    try {
      await filesApi.rollback(file.id, versionId);
      message.success('已回滚到该版本');
      onRollback?.();
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRolling('');
    }
  };

  const columns = [
    { title: '版本时间', dataIndex: 'created_at', width: 180, render: (v: string) => formatTime(v) },
    { title: '大小', dataIndex: 'size_bytes', width: 100, render: (v: number) => formatSize(v) },
    { title: '内容哈希(B3)', dataIndex: 'sha256', ellipsis: true, render: (v: string) => (v ? v.slice(0, 12) + '…' : '-') },
    {
      title: '状态',
      width: 90,
      render: (_: unknown, r: FileVersion) =>
        r.version_id === currentVersion ? <Tag color="green">当前版本</Tag> : <Tag>历史</Tag>,
    },
    {
      title: '操作',
      width: 110,
      render: (_: unknown, r: FileVersion) =>
        r.version_id === currentVersion ? null : (
          <Popconfirm title="回滚后当前内容将被覆盖，确认？" onConfirm={() => void rollback(r.version_id)}>
            <Button size="small" type="link" icon={<RollbackOutlined />} loading={rolling === r.version_id} disabled={!!rolling}>
              回滚
            </Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Modal open={!!file} onCancel={onClose} footer={null} width={760} destroyOnHidden title={`版本管理 - ${file?.name ?? ''}`}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        基于 MinIO 对象版本控制，每次上传自动保留历史版本；修改后可通过「回滚」恢复旧内容。
      </Typography.Paragraph>
      <Table rowKey="version_id" size="small" loading={loading} columns={columns} dataSource={versions} pagination={false} />    </Modal>
  );
}
