// 上传恢复入口（v1.0.13）：Token 过期暂停队列后，提示重新登录并继续上传
// 点击后：跳转登录页 → 登录成功 → 返回本页 → 恢复 auth-failed 任务（不重置已传进度）
import { Alert, Button, Space } from 'antd';
import { LoginOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useUploadStore } from '../store/upload';

export default function UploadResumeButton() {
  const navigate = useNavigate();
  const paused = useUploadStore((s) => s.paused);
  const pauseReason = useUploadStore((s) => s.pauseReason);
  const tasks = useUploadStore((s) => s.tasks);
  const resumeAuth = useUploadStore((s) => s.resumeAuth);

  // 仅 Token 过期暂停时显示
  if (!paused || pauseReason !== 'token_expired') return null;

  const authFailedCount = Object.values(tasks).filter((t) => t.status === 'auth-failed').length;
  const hasToken = !!localStorage.getItem('nd_access_token');

  const handleResume = (): void => {
    // 有 token（可能已重新登录）→ 直接恢复；无 token → 去登录
    if (hasToken) {
      resumeAuth();
    } else {
      // 记录来源，登录后返回本页自动恢复（LoginPage 处理 afterLogin）
      try {
        sessionStorage.setItem('nd_resume_upload', '1');
      } catch {
        /* ignore */
      }
      navigate('/login');
    }
  };

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message={`登录已过期，${authFailedCount} 个文件等待继续上传`}
      description="为避免数据丢失，上传已暂停。请重新登录后点击「继续上传」恢复（已上传部分不会重复上传）。"
      action={
        <Space>
          <Button size="small" icon={<LoginOutlined />} onClick={handleResume}>
            {hasToken ? '继续上传' : '重新登录'}
          </Button>
          {hasToken && (
            <Button size="small" icon={<PlayCircleOutlined />} onClick={() => resumeAuth()}>
              立即恢复
            </Button>
          )}
        </Space>
      }
    />
  );
}
