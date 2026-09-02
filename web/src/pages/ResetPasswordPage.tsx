// 重置链接页：从找回邮件中的链接进入（/reset-password?token=xxx，一次性、30 分钟有效）
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Form, Input, Button, message, Alert, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { authApi } from '../api';
import { passwordStrengthRule } from '../utils/password';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (values: { newPassword: string; confirm: string }): Promise<void> => {
    if (!token) {
      message.error('重置链接无效');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.resetByLink(token, values.newPassword);
      message.success(res.message || '密码已重置');
      setDone(true);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <Card className="login-card" style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', fontSize: 32, color: '#1677ff', marginBottom: 8 }}>
          <LockOutlined />
        </div>
        <div className="login-title">重置密码</div>
        {!token ? (
          <Alert type="error" showIcon message="重置链接无效" description="请通过找回密码邮件中的链接访问本页。" />
        ) : done ? (
          <Alert
            type="success"
            showIcon
            message="密码已重置"
            description="请使用新密码重新登录。"
            action={<Button type="primary" onClick={() => navigate('/login')}>去登录</Button>}
          />
        ) : (
          <>
            <Alert style={{ margin: '12px 0 16px' }} type="info" showIcon message="该链接一次性有效，30 分钟内有效" />
            <Form layout="vertical" onFinish={(v) => void onSubmit(v)}>
              <Form.Item name="newPassword" rules={[{ required: true, message: '请输入新密码' }, passwordStrengthRule]}>
                <Input.Password prefix={<LockOutlined />} placeholder="新密码（≥8 位，含字母和数字）" />
              </Form.Item>
              <Form.Item name="confirm" dependencies={['newPassword']} rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({
                  validator: (_, v) => (v && v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
                }),
              ]}>
                <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                重置密码
              </Button>
            </Form>
          </>
        )}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Link to="/login">返回登录</Link>
        </div>
      </Card>
    </div>
  );
}
