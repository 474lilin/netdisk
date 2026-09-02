// 管理台（企业管理员）：用户 / 部门 / 配额 / 审计
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tabs, Table, Button, Space, Modal, Form, Input, Select, InputNumber, Switch, Tag,
  message, Popconfirm, Tree, Typography, DatePicker, Card, Statistic, Row, Col, Dropdown,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, KeyOutlined, ReloadOutlined,
  UserOutlined, TeamOutlined, DatabaseOutlined, FileSearchOutlined, MoreOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { auditApi, orgApi, quotaApi, usersApi } from '../api';
import type { AuditItem, DeptNode, OrgTree, UserRow } from '../api/types';
import { ROLE_NAMES } from '../api/types';
import { formatSize, formatTime, randomPassword } from '../utils/format';

// ---------- 用户表单 ----------
function UserFormModal(props: {
  open: boolean;
  editing: UserRow | null;
  tree: OrgTree | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { open, editing, tree, onClose, onSaved } = props;
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (editing) {
        form.setFieldsValue({
          username: editing.username,
          displayName: editing.displayName,
          email: editing.email,
          phone: editing.phone,
          role: editing.role,
          deptId: editing.deptId ?? undefined,
          quotaBytes: editing.quotaBytes || undefined,
          status: editing.status === 1,
        });
      }
    }
  }, [open, editing, form]);

  const deptOptions = useMemo(() => flattenDepts(tree?.departments ?? []), [tree]);

  const save = async (): Promise<void> => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        displayName: values.displayName,
        email: values.email || '',
        phone: values.phone || '',
        role: values.role,
        deptId: values.deptId ?? null,
        quotaBytes: values.quotaBytes ?? 0,
        status: values.status ? 1 : 0,
      };
      if (editing) {
        await usersApi.update(editing.id, payload);
        message.success('已保存');
      } else {
        await usersApi.create({ ...payload, username: values.username, initialPassword: values.initialPassword || randomPassword() });
        message.success('用户已创建');
      }
      onSaved();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} onOk={() => void save()} confirmLoading={saving} title={editing ? '编辑用户' : '新建用户'} destroyOnHidden>
      <Form form={form} layout="vertical">
        {!editing && (
          <Form.Item name="username" label="登录名" rules={[{ required: true, message: '请输入登录名' }, { pattern: /^[a-zA-Z0-9._-]{2,64}$/, message: '字母数字._-，2-64位' }]}>
            <Input placeholder="如 zhangsan" />
          </Form.Item>
        )}
        <Form.Item name="displayName" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="email" label="邮箱">
          <Input />
        </Form.Item>
        <Form.Item name="phone" label="手机号">
          <Input />
        </Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}>
          <Select options={[{ value: 3, label: '普通员工' }, { value: 2, label: '部门管理员' }, { value: 1, label: '企业管理员' }]} />
        </Form.Item>
        <Form.Item name="deptId" label="所属部门">
          <Select allowClear options={deptOptions} placeholder="暂不分配" />
        </Form.Item>
        <Form.Item name="quotaBytes" label="个人配额（GB，0 跟随组织）">
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        {!editing && (
          <Form.Item name="initialPassword" label="初始密码（留空自动生成）">
            <Input.Password />
          </Form.Item>
        )}
        {editing && (
          <Form.Item name="status" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

// ---------- 部门树节点 ----------
function DeptTitle({ node, onEdit, onDelete }: { node: DeptNode; onEdit: (n: DeptNode) => void; onDelete: (n: DeptNode) => void }) {
  return (
    <Space size={4}>
      <TeamOutlined style={{ color: '#1677ff' }} />
      <span>{node.name}</span>
      {node.quotaBytes > 0 && <Tag>{formatSize(node.quotaBytes)}</Tag>}
      <Dropdown
        menu={{
          items: [
            { key: 'edit', icon: <EditOutlined />, label: '编辑' },
            { key: 'del', icon: <DeleteOutlined />, label: '删除', danger: true },
          ],
          onClick: ({ key }) => (key === 'edit' ? onEdit(node) : onDelete(node)),
        }}
        trigger={['click']}
      >
        <Button type="text" size="small" icon={<MoreOutlined />} />
      </Dropdown>
    </Space>
  );
}

function flattenDepts(nodes: DeptNode[]): Array<{ label: string; value: string }> {
  return nodes.flatMap((n) => [{ label: n.name, value: n.id }, ...flattenDepts(n.children)]);
}

export default function AdminPage() {
  const [tab, setTab] = useState('users');

  // 用户
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userQ, setUserQ] = useState('');
  const [userLoading, setUserLoading] = useState(false);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);

  // 部门
  const [tree, setTree] = useState<OrgTree | null>(null);
  const [deptFormOpen, setDeptFormOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<DeptNode | null>(null);
  const [deptForm] = Form.useForm();

  // 配额
  const [deptQuotas, setDeptQuotas] = useState<Array<{ id: string; name: string; quota: number; used: number }>>([]);
  const [orgQuota, setOrgQuota] = useState<number | undefined>(0);
  const [orgUsed, setOrgUsed] = useState(0);

  const deptOptions = useMemo(() => flattenDepts(tree?.departments ?? []), [tree]);

  // 审计
  const [auditItems, setAuditItems] = useState<AuditItem[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    setUserLoading(true);
    try {
      const res = await usersApi.list({ page: userPage, pageSize: 20, q: userQ || undefined });
      setUsers(res.items);
      setUserTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUserLoading(false);
    }
  }, [userPage, userQ]);

  const loadTree = useCallback(async () => {
    try {
      const t = await orgApi.tree();
      setTree(t);
    } catch (e) {
      message.error((e as Error).message);
    }
  }, []);

  const loadQuotas = useCallback(async () => {
    try {
      const [usage, deptRes] = await Promise.all([quotaApi.usage(), quotaApi.deptSummary()]);
      setOrgQuota(usage.orgLimit || undefined);
      setOrgUsed(usage.orgUsed);
      setDeptQuotas(deptRes.items);
    } catch (e) {
      message.error((e as Error).message);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await auditApi.list({ page: auditPage, pageSize: 20, action: auditAction || undefined });
      setAuditItems(res.items);
      setAuditTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAuditLoading(false);
    }
  }, [auditPage, auditAction]);

  useEffect(() => {
    if (tab === 'users') void loadUsers();
    if (tab === 'depts') void loadTree();
    if (tab === 'quota') void loadQuotas();
    if (tab === 'audit') void loadAudit();
  }, [tab, loadUsers, loadTree, loadQuotas, loadAudit]);

  const resetPassword = (user: UserRow): void => {
    Modal.confirm({
      title: `重置「${user.displayName || user.username}」的密码？`,
      content: '将吊销该用户全部登录会话。',
      okText: '重置',
      onOk: async () => {
        const pwd = randomPassword();
        await usersApi.resetPassword(user.id, pwd);
        Modal.success({ title: '密码已重置', content: `新密码：${pwd}（请立即告知用户并提醒修改）` });
      },
    });
  };

  const userColumns: ColumnsType<UserRow> = [
    { title: '登录名', dataIndex: 'username', width: 140 },
    { title: '姓名', dataIndex: 'displayName' },
    { title: '部门', dataIndex: 'dept_name', render: (v?: string) => v || '-' },
    { title: '角色', dataIndex: 'role', width: 110, render: (v: number) => <Tag color={v === 1 ? 'gold' : v === 2 ? 'blue' : 'default'}>{ROLE_NAMES[v as keyof typeof ROLE_NAMES]}</Tag> },
    { title: '状态', dataIndex: 'status', width: 80, render: (v: number) => (v === 1 ? <Tag color="success">启用</Tag> : <Tag color="error">禁用</Tag>) },
    { title: '配额', dataIndex: 'quotaBytes', width: 90, render: (v: number) => (v > 0 ? formatSize(v) : '跟随组织') },
    { title: '已用', dataIndex: 'usedBytes', width: 90, render: (v: number) => formatSize(v) },
    { title: '登录源', dataIndex: 'authSource', width: 80, render: (v: string) => <Tag>{v === 'local' ? '本地' : v}</Tag> },
    {
      title: '操作',
      width: 200,
      render: (_: unknown, u: UserRow) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setEditingUser(u); setUserFormOpen(true); }} />
          <Button size="small" icon={<KeyOutlined />} onClick={() => void resetPassword(u)} />
          <Popconfirm title="确认删除该用户？" onConfirm={() => void removeUser(u)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const removeUser = async (u: UserRow): Promise<void> => {
    try {
      await usersApi.remove(u.id);
      message.success('已删除');
      void loadUsers();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const saveDept = async (): Promise<void> => {
    const values = await deptForm.validateFields();
    try {
      if (editingDept) {
        await orgApi.updateDept(editingDept.id, { name: values.name, quotaBytes: (values.quotaBytes ?? 0) * 1024 ** 3 });
        message.success('已保存');
      } else {
        await orgApi.createDept({ name: values.name, parentId: values.parentId ?? null, quotaBytes: (values.quotaBytes ?? 0) * 1024 ** 3 });
        message.success('部门已创建');
      }
      setDeptFormOpen(false);
      void loadTree();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const auditColumns: ColumnsType<AuditItem> = [
    { title: '时间', dataIndex: 'created_at', width: 160, render: (v: string) => formatTime(v) },
    { title: '操作人', dataIndex: 'user_name', width: 110, render: (v?: string) => v || '系统' },
    { title: '动作', dataIndex: 'action', width: 130, render: (v: string) => <Tag>{v}</Tag> },
    { title: '对象', dataIndex: 'target_type', width: 90, render: (v: string) => v || '-' },
    { title: '详情', dataIndex: 'detail', ellipsis: true, render: (v: Record<string, unknown>) => JSON.stringify(v) },
    { title: 'IP', dataIndex: 'ip', width: 130 },
  ];

  const treeData = useMemo(() => {
    const build = (nodes: DeptNode[]): Array<{ key: string; title: React.ReactNode; children?: unknown[] }> =>
      nodes.map((n) => ({
        key: n.id,
        title: <DeptTitle node={n} onEdit={(node) => { setEditingDept(node); deptForm.setFieldsValue({ name: node.name, quotaBytes: node.quotaBytes ? node.quotaBytes / 1024 ** 3 : undefined }); setDeptFormOpen(true); }} onDelete={(node) => void removeDept(node)} />,
        children: build(n.children),
      }));
    return build(tree?.departments ?? []);
  }, [tree, deptForm]);

  const removeDept = async (node: DeptNode): Promise<void> => {
    try {
      await orgApi.deleteDept(node.id);
      message.success('已删除');
      void loadTree();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'users',
            label: <span><UserOutlined /> 用户管理</span>,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Input.Search placeholder="搜索用户" allowClear style={{ width: 260 }} onSearch={(v) => { setUserQ(v); setUserPage(1); }} />
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingUser(null); setUserFormOpen(true); }}>
                    新建用户
                  </Button>
                </Space>
                <Table rowKey="id" size="middle" loading={userLoading} columns={userColumns} dataSource={users} pagination={{ current: userPage, pageSize: 20, total: userTotal, onChange: setUserPage }} />
              </>
            ),
          },
          {
            key: 'depts',
            label: <span><TeamOutlined /> 部门管理</span>,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditingDept(null); deptForm.resetFields(); setDeptFormOpen(true); }}>
                    新建部门
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={() => void loadTree()} />
                </Space>
                <Tree showLine defaultExpandAll treeData={treeData as never} />
              </>
            ),
          },
          {
            key: 'quota',
            label: <span><DatabaseOutlined /> 存储配额</span>,
            children: (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}>
                    <Card size="small">
                      <Statistic title="企业总配额" value={orgQuota && orgQuota > 0 ? formatSize(orgQuota) : '不限制'} />
                      <Space style={{ marginTop: 8 }}>
                        <InputNumber
                          min={0}
                          placeholder="GB"
                          style={{ width: 120 }}
                          onChange={(v) => setOrgQuota(v ?? 0)}
                          value={orgQuota ? orgQuota / 1024 ** 3 : undefined}
                        />
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => quotaApi.setOrg((orgQuota ?? 0)).then(() => message.success('已保存')).catch((e) => message.error((e as Error).message))}
                        >
                          设置
                        </Button>
                      </Space>
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small">
                      <Statistic title="企业已用" value={formatSize(orgUsed)} />
                    </Card>
                  </Col>
                </Row>
                <Typography.Title level={5}>部门配额</Typography.Title>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={deptQuotas}
                  pagination={false}
                  columns={[
                    { title: '部门', dataIndex: 'name' },
                    { title: '配额', dataIndex: 'quota', render: (v: number) => (v > 0 ? formatSize(v) : '不限制') },
                    { title: '已用', dataIndex: 'used', render: (v: number) => formatSize(v) },
                    {
                      title: '操作',
                      render: (_: unknown, d: { id: string; quota: number }) => (
                        <InputNumber
                          size="small"
                          min={0}
                          defaultValue={d.quota ? d.quota / 1024 ** 3 : undefined}
                          addonAfter="GB"
                          onBlur={(e) => {
                            const gb = Number(e.target.value || 0);
                            quotaApi.setDept(d.id, gb * 1024 ** 3).then(() => message.success('已保存')).catch((err) => message.error((err as Error).message));
                          }}
                        />
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'audit',
            label: <span><FileSearchOutlined /> 审计日志</span>,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="操作类型"
                    style={{ width: 180 }}
                    value={auditAction || undefined}
                    onChange={(v) => { setAuditAction(v ?? ''); setAuditPage(1); }}
                    options={[
                      'login', 'logout', 'upload_complete', 'download', 'preview', 'delete', 'restore', 'purge',
                      'move', 'copy', 'rename', 'mkdir', 'version_rollback', 'share_create', 'share_revoke', 'share_download',
                      'acl_update', 'grant_add', 'user_create', 'user_update', 'quota_update', 'password_change',
                    ].map((a) => ({ value: a, label: a }))}
                  />
                  <Button icon={<ReloadOutlined />} onClick={() => void loadAudit()} />
                </Space>
                <Table rowKey="id" size="small" loading={auditLoading} columns={auditColumns} dataSource={auditItems} pagination={{ current: auditPage, pageSize: 20, total: auditTotal, onChange: setAuditPage }} />
              </>
            ),
          },
        ]}
      />

      {/* 弹窗 */}
      <UserFormModal open={userFormOpen} editing={editingUser} tree={tree} onClose={() => setUserFormOpen(false)} onSaved={() => void loadUsers()} />
      <Modal open={deptFormOpen} onCancel={() => setDeptFormOpen(false)} onOk={() => void saveDept()} title={editingDept ? '编辑部门' : '新建部门'} destroyOnHidden>
        <Form form={deptForm} layout="vertical">
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: '请输入部门名称' }]}>
            <Input />
          </Form.Item>
          {!editingDept && (
            <Form.Item name="parentId" label="上级部门">
              <Select allowClear placeholder="无（一级部门）" options={deptOptions} />
            </Form.Item>
          )}
          <Form.Item name="quotaBytes" label="部门配额（GB，0 不限制）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
