// 自助注册：账号 + 邮箱/手机验证码（防恶意注册）+ 算术 CAPTCHA + 密码强度 + 用户协议
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, Form, Input, Button, message, Checkbox, Alert, Typography, Modal } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined, SafetyOutlined } from '@ant-design/icons';
import { authApi } from '../api';
import { passwordStrengthRule } from '../utils/password';

// 用户协议全文（阅读界面）
const USER_TERMS = [
  { h: '一、账号与安全', items: ['账号仅限本人使用，禁止转让、出借或共享；因保管不善导致账号被盗用，用户自行承担相应责任。', '密码应设置足够强度并定期更换；发现异常登录应立即修改密码并联系管理员。'] },
  { h: '二、使用规范', items: ['不得上传、存储、分享违反法律法规或企业规章的内容（含涉密、违法、侵权材料）。', '不得利用系统从事任何危害系统运行、数据安全或他人权益的行为（如恶意攻击、批量爬取）。'] },
  { h: '三、数据与隐私', items: ['用户文件仅限授权范围内访问；系统记录操作审计日志，供合规审计使用。', '管理员可能按企业制度查看与处置违规文件，请遵守企业网络与数据安全规定。'] },
  { h: '四、责任与终止', items: ['违反本协议可能导致账号被禁用或数据被处置，由违规者承担相应后果。', '企业保留根据实际情况调整服务与协议条款的权利，更新后于本页公示。'] },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [captcha, setCaptcha] = useState<{ id: string; question: string } | null>(null);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [sentMask, setSentMask] = useState('');
  const [countdown, setCountdown] = useState(0); // 验证码发送冷却倒计时（秒）
  const [agreeOpen, setAgreeOpen] = useState(false); // 用户协议阅读弹窗（受控：多次点击只维持一个）
  const [form] = Form.useForm();
  const target = Form.useWatch('target', form) || '';
  const cdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCaptcha = async (): Promise<void> => {
    try {
      setCaptcha(await authApi.captcha());
      setCaptchaFailed(false);
    } catch {
      setCaptcha(null);
      setCaptchaFailed(true);
    }
  };
  useEffect(() => {
    void loadCaptcha();
  }, []);

  // 发送成功开始 60s 冷却倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const sendCode = async (): Promise<void> => {
    const t = target.trim();
    if (!t) {
      message.warning('请先填写邮箱或手机号');
      return;
    }
    if (countdown > 0) return;
    setSending(true);
    try {
      const res = await authApi.registerSendCode(t, captcha?.id ?? '', Number(form.getFieldValue('captchaAnswer')));
      if (res.ok) {
        setSentMask(res.masked);
        message.success(res.message);
        setCountdown(60);
        void loadCaptcha();
      } else {
        message.error(res.message || '发送失败');
        void loadCaptcha();
      }
    } catch (e) {
      message.error((e as Error).message);
      void loadCaptcha();
    } finally {
      setSending(false);
    }
  };

  const onSubmit = async (values: { username: string; password: string; confirm: string; displayName?: string; target: string; code: string; captchaAnswer: number; agree: boolean }): Promise<void> => {
    setLoading(true);
    try {
      const res = await authApi.register({
        username: values.username,
        password: values.password,
        displayName: values.displayName,
        target: values.target.trim(),
        code: values.code,
        agreeTerms: values.agree,
        captchaId: captcha?.id,
        captchaAnswer: values.captchaAnswer,
      });
      message.success(res.message || '注册成功');
      navigate('/login');
    } catch (e) {
      message.error((e as Error).message);
      void loadCaptcha();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <Card className="login-card" style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ textAlign: 'center', fontSize: 32, color: '#1677ff', marginBottom: 8 }}>
          <UserOutlined />
        </div>
        <div className="login-title">注册账号</div>
        <Alert
          style={{ margin: '12px 0 16px' }}
          type="info"
          showIcon
          message="注册需邮箱/手机验证码验证，防止恶意注册"
        />
        <Form form={form} layout="vertical" onFinish={(v) => void onSubmit(v)}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入登录名' }, { pattern: /^[a-zA-Z0-9_.-]{3,32}$/, message: '3-32 位字母/数字/._-' }]}>
            <Input prefix={<UserOutlined />} placeholder="登录名（3-32 位）" />
          </Form.Item>
          <Form.Item name="displayName">
            <Input placeholder="姓名/昵称（可选）" />
          </Form.Item>
          <Form.Item name="target" rules={[{ required: true, message: '请输入邮箱或手机号' }]}>
            <Input prefix={<MailOutlined />} placeholder="邮箱或手机号（用于验证）" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Form.Item name="code" rules={[{ required: true, message: '请输入验证码' }, { len: 6, message: '6 位验证码' }]} style={{ flex: 1, marginBottom: 0 }}>
              <Input placeholder="6 位验证码" maxLength={6} />
            </Form.Item>
            <Button onClick={() => void sendCode()} loading={sending} disabled={!captcha || countdown > 0} style={{ marginBottom: 0 }}>
              {countdown > 0 ? `${countdown}s 后重发` : sentMask ? `已发送至 ${sentMask}（重发）` : '发送验证码'}
            </Button>
          </div>
          <Form.Item name="captchaAnswer" rules={[{ required: true, message: '请输入算术结果' }]}>
            <Input
              prefix={<SafetyOutlined />}
              placeholder={captcha ? `人机验证：${captcha.question}` : captchaFailed ? '人机验证加载失败，点击下方重试' : '人机验证加载中…'}
              type="number"
              disabled={!captcha}
            />
          </Form.Item>
          {captchaFailed && (
            <Button type="link" size="small" style={{ padding: 0, marginBottom: 8 }} onClick={() => void loadCaptcha()}>
              人机验证加载失败，点击重试
            </Button>
          )}
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, passwordStrengthRule]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码（≥8 位，含字母和数字）" />
          </Form.Item>
          <Form.Item name="confirm" dependencies={['password']} rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({
              validator: (_, v) => (v && v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
            }),
          ]}>
            <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
          </Form.Item>
          <Form.Item name="agree" valuePropName="checked" rules={[{ validator: (_, v) => (v ? Promise.resolve() : Promise.reject(new Error('请先阅读并同意用户协议'))) }]}>
            <Checkbox>
              我已阅读并同意
              <Typography.Link
                onClick={(e) => {
                  // 阻止事件冒泡，避免打开协议阅读时误勾选/取消勾选
                  e.preventDefault();
                  e.stopPropagation();
                  setAgreeOpen(true);
                }}
              >
                用户协议
              </Typography.Link>
            </Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            注 册
          </Button>
        </Form>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Typography.Text type="secondary">已有账号？</Typography.Text> <Link to="/login">去登录</Link>
        </div>
      </Card>

      {/* 用户协议阅读弹窗（受控 Modal：无论点击多少次只显示一个阅读界面） */}
      <Modal
        open={agreeOpen}
        title="用户协议"
        onCancel={() => setAgreeOpen(false)}
        width={560}
        footer={[
          <Button key="close" type="primary" onClick={() => setAgreeOpen(false)}>
            我已阅读
          </Button>,
        ]}
      >
        <div style={{ maxHeight: '55vh', overflow: 'auto', paddingRight: 8 }}>
          {USER_TERMS.map((sec) => (
            <div key={sec.h} style={{ marginBottom: 12 }}>
              <Typography.Text strong>{sec.h}</Typography.Text>
              {sec.items.map((t) => (
                <Typography.Paragraph key={t} style={{ fontSize: 13, color: 'rgba(0,0,0,0.75)', marginBottom: 4 }}>
                  {t}
                </Typography.Paragraph>
              ))}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
