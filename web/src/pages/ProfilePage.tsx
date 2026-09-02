// 个人中心：配额用量 + 修改密码 + 双重认证(2FA) + 登录设备管理
import { useCallback, useEffect, useState } from 'react';
import { Card, Col, Progress, Row, Statistic, Form, Input, Button, message, Typography, Space, Tag, List, Modal, Alert } from 'antd';
import { KeyOutlined, SafetyOutlined, LaptopOutlined, DeleteOutlined } from '@ant-design/icons';
import { authApi, quotaApi } from '../api';
import { useAuthStore } from '../store/auth';
import type { QuotaInfo } from '../api/types';
import { formatSize, formatTime } from '../utils/format';
import { passwordStrengthRule } from '../utils/password';

interface DeviceItem {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export default function ProfilePage() {
  const { user, setUser } = useAuthStore();
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  // 2FA
  const [twofa, setTwofa] = useState<{ enabled: boolean; hasSecret: boolean }>({ enabled: false, hasSecret: false });
  const [setupData, setSetupData] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [twofaCode, setTwofaCode] = useState('');
  const [twofaBusy, setTwofaBusy] = useState(false);
  const [disablePwd, setDisablePwd] = useState('');

  // 设备
  const [devices, setDevices] = useState<DeviceItem[]>([]);

  const load = useCallback(async () => {
    try {
      setQuota(await quotaApi.usage());
    } catch (e) {
      message.error((e as Error).message);
    }
  }, []);

  const loadTwofa = useCallback(async () => {
    try {
      setTwofa(await authApi.twofaStatus());
    } catch {
      /* ignore */
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const res = await authApi.sessions();
      setDevices(res.items);
    } catch (e) {
      message.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadTwofa();
    void loadDevices();
  }, [load, loadTwofa, loadDevices]);

  const changePwd = async (values: { oldPassword: string; newPassword: string }): Promise<void> => {
    setSaving(true);
    try {
      await authApi.changePassword(values.oldPassword, values.newPassword);
      message.success('密码已修改，请重新登录');
      setTimeout(() => void useAuthStore.getState().logout().then(() => (window.location.href = '/login')), 500);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const startSetup = async (): Promise<void> => {
    setTwofaBusy(true);
    try {
      const res = await authApi.twofaSetup();
      setSetupData(res);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTwofaBusy(false);
    }
  };

  const confirmSetup = async (): Promise<void> => {
    setTwofaBusy(true);
    try {
      await authApi.twofaConfirm(twofaCode);
      message.success('2FA 已启用');
      setSetupData(null);
      setTwofaCode('');
      void loadTwofa();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTwofaBusy(false);
    }
  };

  const doDisable = async (): Promise<void> => {
    setTwofaBusy(true);
    try {
      await authApi.twofaDisable(twofaCode, disablePwd);
      message.success('2FA 已关闭');
      setTwofaCode('');
      setDisablePwd('');
      void loadTwofa();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTwofaBusy(false);
    }
  };

  // 关闭 2FA 为安全敏感操作：二次确认
  const confirmDisable = (): void => {
    Modal.confirm({
      title: '关闭双重认证（2FA）？',
      content: '关闭后登录将不再需要动态验证码，账号安全性下降。确认关闭吗？',
      okText: '关闭',
      okButtonProps: { danger: true },
      onOk: () => doDisable(),
    });
  };

  const revoke = async (id: string): Promise<void> => {
    try {
      await authApi.revokeSession(id);
      message.success('该设备已下线');
      void loadDevices();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // 下线设备为安全敏感操作：二次确认
  const confirmRevoke = (id: string): void => {
    Modal.confirm({
      title: '将该设备下线？',
      content: '下线后该设备需要重新登录才能访问网盘。',
      okText: '下线',
      okButtonProps: { danger: true },
      onOk: () => revoke(id),
    });
  };

  const pct = quota && quota.limitBytes > 0 ? Math.min(100, Math.round((quota.usedBytes / quota.limitBytes) * 100)) : 0;
  const authSourceLabel = user?.authSource === 'local' ? '本地账号' : user?.authSource === 'ldap' ? 'LDAP 域账号' : user?.authSource || '-';

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={10}>
        <Card title="账号信息">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>登录名：{user?.username}</Typography.Text>
            <Typography.Text>姓名：{user?.displayName}</Typography.Text>
            <Typography.Text>
              角色：
              {user?.role === 1 ? <Tag color="gold">企业管理员</Tag> : user?.role === 2 ? <Tag color="blue">部门管理员</Tag> : <Tag>普通员工</Tag>}
            </Typography.Text>
            <Typography.Text>登录源：{authSourceLabel}</Typography.Text>
          </Space>
        </Card>
        <Card title="存储用量" style={{ marginTop: 16 }}>
          {quota && (
            <>
              <Row gutter={16}>
                <Col span={12}>
                  <Statistic title="已用" value={formatSize(quota.usedBytes)} />
                </Col>
                <Col span={12}>
                  <Statistic title="配额" value={quota.level === 'unlimited' ? '不限制' : formatSize(quota.limitBytes)} />
                </Col>
              </Row>
              {quota.level === 'unlimited' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前不限制存储空间</Typography.Text>
              ) : (
                <Progress percent={pct} status={pct >= 90 ? 'exception' : 'active'} style={{ marginTop: 12 }} />
              )}
            </>
          )}
        </Card>
      </Col>
      <Col xs={24} lg={14}>
        <Card title={<Space><KeyOutlined /> 修改密码</Space>}>
          <Form form={form} layout="vertical" onFinish={(v) => void changePwd(v)}>
            <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, passwordStrengthRule]}>
              <Input.Password />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认新密码"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请再次输入新密码' },
                ({ getFieldValue }) => ({
                  validator: (_, v) => (v && v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={saving} block>
              确认修改
            </Button>
          </Form>
        </Card>

        <Card title={<Space><SafetyOutlined /> 双重认证（2FA）</Space>} style={{ marginTop: 16 }}>
          {twofa.enabled ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Alert type="success" showIcon message="已启用动态验证（TOTP）。登录时需输入身份验证器动态码。" />
              <Space>
                <Input placeholder="当前 2FA 动态码" maxLength={6} value={twofaCode} onChange={(e) => setTwofaCode(e.target.value.replace(/\D/g, ''))} style={{ width: 180 }} />
                <Input.Password placeholder="登录密码" value={disablePwd} onChange={(e) => setDisablePwd(e.target.value)} style={{ width: 180 }} />
                <Button danger loading={twofaBusy} onClick={() => confirmDisable()} disabled={!twofaCode || !disablePwd || twofaCode.length !== 6}>
                  关闭 2FA
                </Button>
              </Space>
            </Space>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              {setupData ? (
                <>
                  <Alert type="info" showIcon message="使用身份验证器 App（如 Google Authenticator）扫描二维码，或手动输入密钥后输入动态码完成绑定。" />
                  <div style={{ textAlign: 'center' }}>
                    <img src={setupData.qrDataUrl} alt="2FA 二维码" style={{ width: 200, height: 200, border: '1px solid #f0f0f0', borderRadius: 8 }} />
                  </div>
                  <Typography.Paragraph copyable style={{ textAlign: 'center' }}>
                    密钥：{setupData.secret}
                  </Typography.Paragraph>
                  <Space style={{ justifyContent: 'center', width: '100%' }}>
                    <Input placeholder="输入 6 位动态码验证" maxLength={6} value={twofaCode} onChange={(e) => setTwofaCode(e.target.value)} style={{ width: 200 }} />
                    <Button type="primary" loading={twofaBusy} onClick={() => void confirmSetup()} disabled={twofaCode.length !== 6}>
                      确认启用
                    </Button>
                    <Button onClick={() => setSetupData(null)}>取消</Button>
                  </Space>
                </>
              ) : (
                <>
                  <Typography.Text type="secondary">启用后登录需输入身份验证器（如 Google Authenticator / Microsoft Authenticator）的 6 位动态码。</Typography.Text>
                  <Button type="primary" loading={twofaBusy} onClick={() => void startSetup()} style={{ width: 200 }}>
                    开启 2FA
                  </Button>
                </>
              )}
            </Space>
          )}
        </Card>

        <Card title={<Space><LaptopOutlined /> 登录设备</Space>} style={{ marginTop: 16 }}>
          <List
            size="small"
            dataSource={devices}
            locale={{ emptyText: '暂无其他登录设备' }}
            renderItem={(d) => (
              <List.Item
                actions={[
                  d.current ? (
                    <Tag color="blue">当前设备</Tag>
                  ) : (
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmRevoke(d.id)}>
                      下线
                    </Button>
                  ),
                ]}
              >
                <Space direction="vertical" size={0}>
                  <Typography.Text>{d.userAgent ? d.userAgent.slice(0, 60) : '未知设备'}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    IP {d.ip || '-'} · 登录于 {formatTime(d.createdAt)}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      </Col>
    </Row>
  );
}
