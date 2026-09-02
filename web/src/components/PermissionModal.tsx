// 权限弹窗：目录 ACL（读/写/删/享）+ 内部授权（share_grants）
import { useCallback, useEffect, useState } from 'react';
import { Modal, Tabs, Table, Select, Checkbox, Button, Space, message, Popconfirm, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { filesApi, orgApi } from '../api';
import type { AclRow, FileItem, GrantRow } from '../api/types';
import { TARGET_NAMES } from '../api/types';
import { formatTime } from '../utils/format';

interface Props {
  target: FileItem | null;
  onClose: () => void;
}

interface Candidates {
  users: Array<{ id: string; name: string; deptName: string }>;
  departments: Array<{ id: string; name: string }>;
}

export default function PermissionModal({ target, onClose }: Props) {
  const [candidates, setCandidates] = useState<Candidates>({ users: [], departments: [] });
  const [acls, setAcls] = useState<AclRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(false);

  // 新增 ACL 表单
  const [aclTargetType, setAclTargetType] = useState<number>(2);
  const [aclTargetId, setAclTargetId] = useState<string>('');
  const [aclFlags, setAclFlags] = useState({ canRead: true, canWrite: false, canDelete: false, canShare: false });

  // 新增授权表单
  const [grantTargetType, setGrantTargetType] = useState<number>(2);
  const [grantTargetId, setGrantTargetId] = useState<string>('');
  const [grantFlags, setGrantFlags] = useState({ canWrite: false, canDelete: false });

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const [c, a, g] = await Promise.all([
        orgApi.candidates(),
        target.type === 'dir' ? filesApi.acls(target.id) : Promise.resolve({ items: [] }),
        filesApi.grants(target.id, target.type),
      ]);
      setCandidates(c);
      setAcls(a.items);
      setGrants(g.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  const targetLabel = (type: number, id: string): string => {
    if (type === 1) return candidates.users.find((u) => u.id === id)?.name ?? id;
    if (type === 2) return candidates.departments.find((d) => d.id === id)?.name ?? id;
    return '企业全员';
  };

  const addAcl = async (): Promise<void> => {
    if (!target || !aclTargetId) {
      message.warning('请选择授权对象');
      return;
    }
    try {
      await filesApi.upsertAcl(target.id, {
        targetType: aclTargetType,
        targetId: aclTargetId,
        ...aclFlags,
      });
      message.success('ACL 已保存');
      setAclTargetId('');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const addGrant = async (): Promise<void> => {
    if (!target || !grantTargetId) {
      message.warning('请选择授权对象');
      return;
    }
    try {
      await filesApi.addGrant(target.id, {
        type: target.type,
        targetType: grantTargetType,
        targetId: grantTargetId,
        ...grantFlags,
      });
      message.success('已授权');
      setGrantTargetId('');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const targetOptions = (type: number): { label: string; value: string }[] => {
    if (type === 1) return candidates.users.map((u) => ({ label: `${u.name}${u.deptName ? `（${u.deptName}）` : ''}`, value: u.id }));
    if (type === 2) return candidates.departments.map((d) => ({ label: d.name, value: d.id }));
    return [{ label: '企业全员', value: 'org' }];
  };

  const aclColumns = [
    { title: '授权对象', dataIndex: 'target_type', width: 160, render: (t: number, r: AclRow) => `${TARGET_NAMES[t]}: ${targetLabel(t, r.target_id)}` },
    { title: '读', dataIndex: 'can_read', width: 50, render: (v: boolean) => (v ? '✓' : '') },
    { title: '写', dataIndex: 'can_write', width: 50, render: (v: boolean) => (v ? '✓' : '') },
    { title: '删', dataIndex: 'can_delete', width: 50, render: (v: boolean) => (v ? '✓' : '') },
    { title: '享', dataIndex: 'can_share', width: 50, render: (v: boolean) => (v ? '✓' : '') },
    {
      title: '操作',
      width: 70,
      render: (_: unknown, r: AclRow) => (
        <Popconfirm title="确认删除该 ACL？" onConfirm={() => void removeAcl(r.id)}>
          <Button type="link" size="small" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const grantColumns = [
    { title: '授权对象', dataIndex: 'target_type', width: 160, render: (t: number, r: GrantRow) => `${TARGET_NAMES[t]}: ${targetLabel(t, r.target_id)}` },
    { title: '可写', dataIndex: 'can_write', width: 70, render: (v: boolean) => (v ? '✓' : '') },
    { title: '可删', dataIndex: 'can_delete', width: 70, render: (v: boolean) => (v ? '✓' : '') },
    { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => formatTime(v) },
    {
      title: '操作',
      width: 70,
      render: (_: unknown, r: GrantRow) => (
        <Popconfirm title="确认取消该授权？" onConfirm={() => void removeGrant(r.id)}>
          <Button type="link" size="small" danger>
            取消
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const removeAcl = async (id: number): Promise<void> => {
    try {
      await filesApi.removeAcl(id);
      message.success('已删除');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const removeGrant = async (id: string): Promise<void> => {
    try {
      await filesApi.removeGrant(id);
      message.success('已取消授权');
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const selectTargetControl = (
    type: number,
    value: string,
    onChange: (v: string) => void,
    placeholder: string
  ): React.ReactNode => (
    <Select
      showSearch
      style={{ width: 220 }}
      placeholder={placeholder}
      value={value || undefined}
      onChange={onChange}
      options={targetOptions(type)}
      optionFilterProp="label"
    />
  );

  return (
    <Modal open={!!target} onCancel={onClose} footer={null} width={760} destroyOnHidden title={`权限设置 - ${target?.name ?? ''}`}>
      <Tabs
        items={[
          {
            key: 'acl',
            label: '目录访问权限（ACL）',
            children:
              target?.type === 'dir' ? (
                <>
                  <Space wrap style={{ marginBottom: 12 }}>
                    <Select value={aclTargetType} onChange={setAclTargetType} style={{ width: 90 }} options={[{ label: '用户', value: 1 }, { label: '部门', value: 2 }, { label: '企业', value: 3 }]} />
                    {selectTargetControl(aclTargetType, aclTargetId, setAclTargetId, '选择对象')}
                    <Checkbox checked={aclFlags.canRead} onChange={(e) => setAclFlags({ ...aclFlags, canRead: e.target.checked })}>读</Checkbox>
                    <Checkbox checked={aclFlags.canWrite} onChange={(e) => setAclFlags({ ...aclFlags, canWrite: e.target.checked })}>写</Checkbox>
                    <Checkbox checked={aclFlags.canDelete} onChange={(e) => setAclFlags({ ...aclFlags, canDelete: e.target.checked })}>删</Checkbox>
                    <Checkbox checked={aclFlags.canShare} onChange={(e) => setAclFlags({ ...aclFlags, canShare: e.target.checked })}>享</Checkbox>
                    <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void addAcl()}>
                      添加
                    </Button>
                  </Space>
                  <Table rowKey="id" size="small" loading={loading} columns={aclColumns} dataSource={acls} pagination={false} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    说明：ACL 叠加在默认权限之上（企业管理员全权、部门盘成员只读等）。
                  </Typography.Text>
                </>
              ) : (
                <Typography.Text type="secondary">ACL 仅支持目录级别；文件请使用下方「内部授权」。</Typography.Text>
              ),
          },
          {
            key: 'grants',
            label: '内部授权（分享给同事）',
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Select value={grantTargetType} onChange={setGrantTargetType} style={{ width: 90 }} options={[{ label: '用户', value: 1 }, { label: '部门', value: 2 }, { label: '企业', value: 3 }]} />
                  {selectTargetControl(grantTargetType, grantTargetId, setGrantTargetId, '选择对象')}
                  <Checkbox checked={grantFlags.canWrite} onChange={(e) => setGrantFlags({ ...grantFlags, canWrite: e.target.checked })}>可写</Checkbox>
                  <Checkbox checked={grantFlags.canDelete} onChange={(e) => setGrantFlags({ ...grantFlags, canDelete: e.target.checked })}>可删</Checkbox>
                  <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => void addGrant()}>
                    授权
                  </Button>
                </Space>
                <Table rowKey="id" size="small" loading={loading} columns={grantColumns} dataSource={grants} pagination={false} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  说明：被授权同事将获得该文件/目录的访问权限（授权不产生外链，仅限内网人员）。
                </Typography.Text>
              </>
            ),
          },
        ]}
      />
    </Modal>
  );
}
