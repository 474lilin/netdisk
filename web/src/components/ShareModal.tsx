// 分享链接弹窗：密码 / 有效期 / 次数限制 / 下载开关
import { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, DatePicker, Switch, Button, message, Alert, Typography, Space } from 'antd';
import { CopyOutlined, LinkOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { sharesApi } from '../api';
import type { FileItem } from '../api/types';

interface Props {
  file: FileItem | null; // 文件或目录
  onClose: () => void;
  onCreated?: () => void;
}

export default function ShareModal({ file, onClose, onCreated }: Props) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareToken, setShareToken] = useState('');

  useEffect(() => {
    if (file) {
      setShareUrl('');
      form.resetFields();
    }
  }, [file, form]);

  const create = async (values: {
    password?: string;
    expiresAt?: dayjs.Dayjs;
    maxAccessCount?: number;
    allowDownload?: boolean;
  }): Promise<void> => {
    if (!file) return;
    setSaving(true);
    try {
      const res = await sharesApi.create({
        fileId: file.type === 'file' ? file.id : undefined,
        dirId: file.type === 'dir' ? file.id : undefined,
        password: values.password || undefined,
        expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
        maxAccessCount: values.maxAccessCount ?? 0,
        allowDownload: values.allowDownload ?? true,
      });
      setShareUrl(res.url);
      setShareToken(res.token);
      onCreated?.();
      message.success('分享链接已创建');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copy = async (): Promise<void> => {
    const fullUrl = `${window.location.origin}${shareUrl}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      message.success('链接已复制到剪贴板');
    } catch {
      window.prompt('复制链接', fullUrl);
    }
  };

  return (
    <Modal
      open={!!file}
      onCancel={onClose}
      footer={null}
      title={<Space><LinkOutlined /> 分享「{file?.name ?? ''}」</Space>}
      destroyOnHidden
    >
      {shareUrl ? (
        <div style={{ marginTop: 12 }}>
          <Alert
            type="success"
            message="分享链接已生成（内网访问）"
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text copyable={{ text: `${window.location.origin}${shareUrl}` }} code>
                  {window.location.origin}{shareUrl}
                </Typography.Text>
                <Button icon={<CopyOutlined />} onClick={() => void copy()}>
                  复制链接
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  提示：该链接仅在贵司内网可访问；请勿将链接转发到外网。
                </Typography.Text>
              </Space>
            }
          />
        </div>
      ) : (
        <Form form={form} layout="vertical" onFinish={(v) => void create(v)} style={{ marginTop: 8 }}>
          <Form.Item name="password" label="访问密码（可选）">
            <Input.Password placeholder="留空则无需密码" maxLength={64} />
          </Form.Item>
          <Form.Item name="expiresAt" label="有效期至（可选）">
            <DatePicker showTime style={{ width: '100%' }} disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item name="maxAccessCount" label="最大访问次数（0 不限）" initialValue={0}>
            <InputNumber min={0} max={1000000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="allowDownload" label="允许下载" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} block>
            生成分享链接
          </Button>
        </Form>
      )}
    </Modal>
  );
}
