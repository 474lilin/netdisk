// 忘记密码：邮箱 / 短信验证码找回（三步：账号+通道 -> 验证码+新密码 -> 成功）
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Steps, Form, Input, Button, message, Select, Alert, Typography } from 'antd';
import { LockOutlined, UserOutlined, MailOutlined, PhoneOutlined } from '@ant-design/icons';
import { authApi } from '../api';
import { passwordStrengthRule } from '../utils/password';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean }>({ email: false, sms: false });
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [mode, setMode] = useState<'code' | 'link'>('code');
  const [username, setUsername] = useState('');
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [noChannel, setNoChannel] = useState(false);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    void authApi
      .resetChannels()
      .then((c) => {
        setChannels(c);
        setChannel(c.email ? 'email' : c.sms ? 'sms' : 'email');
        if (!c.email && !c.sms) setNoChannel(true);
      })
      .catch(() => setChannelsError(true))
      .finally(() => setChannelsLoading(false));
  }, []);

  const sendCode = async (): Promise<void> => {
    setSending(true);
    try {
      const res = await authApi.resetRequest(username, channel, mode);
      message.info(res.message || '验证码已发送');
      setStep(1);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const doReset = async (values: { code: string; newPassword: string }): Promise<void> => {
    setResetting(true);
    try {
      const res = await authApi.resetConfirm(username, channel, values.code, values.newPassword);
      message.success(res.message || '密码已重置');
      setStep(2);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setResetting(false);
    }
  };

  const channelOptions = [
    ...(channels.email ? [{ value: 'email', label: '邮箱验证码' }] : []),
    ...(channels.sms ? [{ value: 'sms', label: '短信验证码' }] : []),
  ];

  return (
    <div className="login-page">
      <Card className="login-card" style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', fontSize: 32, color: '#1677ff', marginBottom: 8 }}>
          <LockOutlined />
        </div>
        <div className="login-title">找回密码</div>
        <Steps
          size="small"
          current={step}
          style={{ margin: '20px 0 24px' }}
          items={[{ title: '账号' }, { title: '重置' }, { title: '完成' }]}
        />

        {noChannel ? (
          <Alert
            type="warning"
            showIcon
            message="未配置找回通道"
            description="管理员未配置邮箱/短信通道。请联系管理员为您重置密码。"
          />
        ) : channelsError ? (
          <Alert
            type="error"
            showIcon
            message="通道信息加载失败"
            description="请检查网络后重试"
            action={<Button size="small" onClick={() => { setChannelsError(false); setChannelsLoading(true); void authApi.resetChannels().then((c) => { setChannels(c); setChannel(c.email ? 'email' : c.sms ? 'sms' : 'email'); if (!c.email && !c.sms) setNoChannel(true); }).catch(() => setChannelsError(true)).finally(() => setChannelsLoading(false)); }}>重试</Button>}
          />
        ) : step === 0 ? (
          <Form layout="vertical" onFinish={() => void sendCode()}>
            <Form.Item name="username" rules={[{ required: true, message: '请输入登录名' }]}>
              <Input
                size="large"
                prefix={<UserOutlined />}
                placeholder="登录名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Form.Item>
            {channelOptions.length > 1 && (
              <Form.Item label="接收方式">
                <Select
                  value={channel}
                  onChange={(v) => setChannel(v)}
                  options={channelOptions}
                  prefix={channel === 'email' ? <MailOutlined /> : <PhoneOutlined />}
                  disabled={channelsLoading}
                />
              </Form.Item>
            )}
            {channel === 'email' && (
              <Form.Item label="重置方式">
                <Select
                  value={mode}
                  onChange={(v) => setMode(v)}
                  options={[
                    { value: 'code', label: '邮箱验证码' },
                    { value: 'link', label: '重置链接（30 分钟内有效）' },
                  ]}
                />
              </Form.Item>
            )}
            <Form.Item>
              <Button type="primary" size="large" block htmlType="submit" loading={sending || channelsLoading}>
                {mode === 'link' ? '发送重置链接' : '发送验证码'}
              </Button>
            </Form.Item>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'center', marginBottom: 0 }}>
              {mode === 'link' ? '重置链接 30 分钟内有效、一次性使用' : '验证码 10 分钟内有效'}；若该账号不存在或未绑定联系方式，将不会收到任何消息。
            </Typography.Paragraph>
          </Form>
        ) : step === 1 ? (
          mode === 'link' ? (
            <Alert
              type="success"
              showIcon
              message="重置链接已发送"
              description="请查收绑定邮箱，点击邮件中的重置链接设置新密码（30 分钟内有效，一次性使用）。"
              action={<Button type="link" onClick={() => navigate('/login')}>返回登录</Button>}
            />
          ) : (
            <Form form={form} layout="vertical" onFinish={(v) => void doReset(v as { code: string; newPassword: string })}>
            <Alert
              style={{ marginBottom: 16 }}
              type="info"
              showIcon
              message={`验证码已发送至${channel === 'email' ? '绑定邮箱' : '绑定手机'}（${username}）`}
            />
            <Form.Item name="code" rules={[{ required: true, message: '请输入 6 位验证码' }, { len: 6, message: '验证码为 6 位' }]}>
              <Input size="large" prefix={<MailOutlined />} placeholder="6 位验证码" maxLength={6} />
            </Form.Item>
            <Form.Item name="newPassword" rules={[{ required: true, message: '请输入新密码' }, passwordStrengthRule]}>
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="新密码（≥8 位，含字母和数字）" />
            </Form.Item>
            <Form.Item name="confirm" dependencies={['newPassword']} rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator: (_, v) => (v && v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
              }),
            ]}>
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="确认新密码" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" size="large" block htmlType="submit" loading={resetting}>
                重置密码
              </Button>
            </Form.Item>
            <Button type="link" block onClick={() => setStep(0)}>
              重新获取验证码
            </Button>
          </Form>
          )
        ) : (
          <Alert
            type="success"
            showIcon
            message="密码已重置"
            description="请使用新密码登录。"
            action={
              <Button type="primary" onClick={() => navigate('/login')}>
                去登录
              </Button>
            }
          />
        )}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/login">返回登录</Link>
        </div>
      </Card>
    </div>
  );
}
