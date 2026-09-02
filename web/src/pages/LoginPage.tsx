// 登录页：账号/邮箱/手机号多方式 + 可选 2FA(TOTP) + 异常登录提示
import { useEffect, useState } from 'react';
import { Form, Input, Button, message, Alert, Typography } from 'antd';
import { UserOutlined, LockOutlined, CloudOutlined, SafetyOutlined } from '@ant-design/icons';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '../api';
import { setToken } from '../api/client';
import { useAuthStore } from '../store/auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useAuthStore((s) => s.setUser);
  const [loading, setLoading] = useState(false);
  const [require2fa, setRequire2fa] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [twofaCode, setTwofaCode] = useState('');
  const [twofaLoading, setTwofaLoading] = useState(false);
  const [risk, setRisk] = useState<{ anomalous: boolean; reason?: string } | null>(null);
  const [expiredMsg, setExpiredMsg] = useState('');

  // 读取会话过期/登出跳转带来的提示（由 client.ts 或登出流程写入 sessionStorage）
  useEffect(() => {
    try {
      const msg = sessionStorage.getItem('nd_login_msg');
      if (msg) {
        sessionStorage.removeItem('nd_login_msg');
        setExpiredMsg(msg);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const afterLogin = (accessToken: string, user: never, from?: string): void => {
    setToken(accessToken);
    setUser(user);
    // v1.0.13：Token 过期恢复上传——登录成功后自动恢复 auth-failed 任务
    let resume = false;
    try {
      resume = sessionStorage.getItem('nd_resume_upload') === '1';
      if (resume) sessionStorage.removeItem('nd_resume_upload');
    } catch {
      /* ignore */
    }
    if (resume) {
      void import('../store/upload').then(({ useUploadStore }) => {
        const s = useUploadStore.getState();
        if (s.paused || Object.values(s.tasks).some((t) => t.status === 'auth-failed')) {
          s.resumeAuth();
        }
      });
    }
    navigate(from || '/', { replace: true });
  };

  const onFinish = async (values: { identifier: string; password: string }): Promise<void> => {
    setLoading(true);
    try {
      const res = await authApi.login(values.identifier.trim(), values.password);
      if (res.require2fa && res.challengeToken) {
        setRequire2fa(true);
        setChallengeToken(res.challengeToken);
        return;
      }
      if (res.risk?.anomalous) setRisk(res.risk);
      const from = (location.state as { from?: string } | null)?.from;
      afterLogin(res.accessToken, res.user as never, from);
    } catch (e) {
      message.error((e as Error).message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const verify2fa = async (): Promise<void> => {
    setTwofaLoading(true);
    try {
      const res = await authApi.verify2fa(challengeToken, twofaCode);
      if (res.risk?.anomalous) setRisk(res.risk);
      const from = (location.state as { from?: string } | null)?.from;
      afterLogin(res.accessToken, res.user as never, from);
    } catch (e) {
      message.error((e as Error).message || '2FA 验证失败');
    } finally {
      setTwofaLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div style={{ textAlign: 'center', fontSize: 40, color: '#1677ff', marginBottom: 8 }}>
          <CloudOutlined />
        </div>
        <div className="login-title">企业私有化网盘</div>
        <div className="login-subtitle">MinIO 分布式对象存储 · 内网私有化部署</div>
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="请使用企业管理员分配的账号登录" />
        {expiredMsg && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={expiredMsg} />
        )}
        {risk?.anomalous && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`异常登录提示：${risk.reason ?? '新设备/新地点'}`}
            description="如非本人操作，请尽快修改密码并检查登录设备。"
          />
        )}
        {!require2fa ? (
          <Form onFinish={(v) => void onFinish(v)} size="large">
            <Form.Item name="identifier" rules={[{ required: true, message: '请输入账号/邮箱/手机号' }]}>
              <Input prefix={<UserOutlined />} placeholder="账号 / 邮箱 / 手机号" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登 录
            </Button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <Link to="/forgot-password" style={{ fontSize: 13 }}>忘记密码？</Link>
              <Link to="/register" style={{ fontSize: 13 }}>注册账号</Link>
            </div>
          </Form>
        ) : (
          <div style={{ textAlign: 'center' }}>
            <SafetyOutlined style={{ fontSize: 36, color: '#1677ff', marginBottom: 8 }} />
            <Typography.Title level={5}>两步验证</Typography.Title>
            <Typography.Paragraph type="secondary">
              该账号已启用动态验证（2FA），请输入身份验证器中的 6 位动态码
            </Typography.Paragraph>
            <Input
              size="large"
              placeholder="6 位动态码"
              maxLength={6}
              value={twofaCode}
              onChange={(e) => setTwofaCode(e.target.value)}
              onPressEnter={() => void verify2fa()}
              style={{ textAlign: 'center', letterSpacing: 6, marginBottom: 12 }}
            />
            <Button type="primary" block loading={twofaLoading} onClick={() => void verify2fa()}>
              验证并登录
            </Button>
            <Button type="link" onClick={() => setRequire2fa(false)} style={{ marginTop: 8 }}>
              返回上一步
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
