// 主布局：侧边栏（空间导航 + 功能入口）+ 顶栏（搜索 + 用户）+ 内容区（移动端响应式）
// v1.1.5：上传队列面板 + 登录过期恢复入口 提升到布局层（任意页面可见；面板为不遮挡页面的悬浮卡片）
import { lazy, Suspense, useEffect, useState } from 'react';
import { Layout, Menu, Input, Dropdown, Avatar, Space, Tag, Button } from 'antd';
import {
  GlobalOutlined,
  TeamOutlined,
  UserOutlined,
  DeleteOutlined,
  LinkOutlined,
  SearchOutlined,
  SettingOutlined,
  CloudOutlined,
  LogoutOutlined,
  KeyOutlined,
  MenuOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { orgApi } from '../../api';
import { useAuthStore } from '../../store/auth';
import { hydrateTaskList } from '../../store/upload';
import type { OrgRoot } from '../../api/types';
import { ROLE_NAMES } from '../../api/types';
import { useIsMobile } from '../../utils/useMediaQuery';
import { startTokenRefreshTimer, trackToken } from '../../utils/token-refresh';
import { useVisibilityCheck } from '../../hooks/useVisibilityCheck';

const { Sider, Header, Content } = Layout;

// 登录过期的恢复入口（懒加载）
const UploadResumeButton = lazy(() => import('../UploadResumeButton'));
// 上传任务右侧常驻栏（占位式，随布局伸缩；桌面端为 Sider，移动端为底部浮层）
import UploadQueue from '../UploadQueue';
// 顶栏固定入口（体积极小，直接静态引入，保证任何时刻都能打开任务列表）
import UploadTaskButton from '../UploadTaskButton';

const ROOT_ICONS: Record<string, React.ReactNode> = {
  user: <UserOutlined />,
  team: <TeamOutlined />,
  global: <GlobalOutlined />,
};

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const isMobile = useIsMobile();
  const [roots, setRoots] = useState<OrgRoot[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [keyword, setKeyword] = useState('');

  // v1.0.13：登录态下启动 Token 主动续期定时器 + 切前台检测（长耗时上传防 Token 过期）
  useVisibilityCheck();
  // v1.1.10：还原上次（刷新/前进后退前）的任务列表——列表不会因整页重载而凭空消失
  useEffect(() => {
    hydrateTaskList();
  }, []);
  useEffect(() => {
    if (!user) return;
    trackToken();
    const stop = startTokenRefreshTimer();
    return () => stop();
  }, [user]);

  useEffect(() => {
    orgApi.roots().then((r) => setRoots(r.roots)).catch(() => undefined);
  }, []);

  const handleSearch = (): void => {
    const q = keyword.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  const userMenu = {
    items: [
      { key: 'profile', icon: <KeyOutlined />, label: '个人中心 / 修改密码' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'profile') navigate('/profile');
      if (key === 'logout') void logout().then(() => navigate('/login'));
    },
  };

  const menuItems = [
    {
      key: 'spaces',
      type: 'group' as const,
      label: '空间',
      children: roots.map((r) => ({
        key: `dir:${r.id}`,
        icon: ROOT_ICONS[r.icon] ?? <CloudOutlined />,
        label: r.name,
      })),
    },
    { type: 'divider' as const },
    { key: 'trash', icon: <DeleteOutlined />, label: '回收站' },
    { key: 'shares', icon: <LinkOutlined />, label: '我的分享' },
    { key: 'search', icon: <SearchOutlined />, label: '搜索' },
    ...(user?.role === 1
      ? [{ key: 'admin', icon: <SettingOutlined />, label: '管理台' }]
      : []),
  ];

  const selectedKey = (() => {
    const path = location.pathname;
    if (path === '/trash') return 'trash';
    if (path === '/shares') return 'shares';
    if (path === '/search') return 'search';
    if (path === '/admin') return 'admin';
    if (path === '/') {
      const m = location.search.match(/dirId=([^&]+)/);
      if (m) return `dir:${m[1]}`;
      if (roots.length > 0) return `dir:${roots[0].id}`;
    }
    return '';
  })();

  return (
    <Layout style={{ height: '100vh' }}>
      {/* 移动端：折叠为 0 宽浮层（汉堡展开），桌面：常规可折叠侧边栏 */}
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="md"
        onBreakpoint={(broken) => {
          if (broken) setCollapsed(true);
        }}
        width={220}
        collapsedWidth={isMobile ? 0 : 80}
        theme="light"
        trigger={null}
        style={{
          borderRight: '1px solid #f0f0f0',
          ...(isMobile
            ? { position: 'fixed', height: '100vh', zIndex: 200, boxShadow: collapsed ? 'none' : '0 4px 16px rgba(0,0,0,0.15)' }
            : {}),
        }}
      >
        <div style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 16, fontWeight: 600 }}>
          <CloudOutlined style={{ color: '#1677ff' }} />
          {!collapsed && <span>企业网盘</span>}
        </div>
        <Menu
          className="sider-menu"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => {
            if (isMobile) setCollapsed(true); // 移动端点击后收起浮层
            if (key.startsWith('dir:')) navigate(`/?dirId=${key.slice(4)}`);
            else navigate(`/${key}`);
          }}
        />
      </Sider>
      {/* 移动端展开 Sider 时的遮罩 */}
      {isMobile && !collapsed && (
        <div
          onClick={() => setCollapsed(true)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 190 }}
        />
      )}
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: isMobile ? '0 8px' : '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            borderBottom: '1px solid #f0f0f0',
            height: 56,
          }}
        >
          <Space size={isMobile ? 4 : 8} style={{ flex: 1, minWidth: 0 }}>
            {isMobile && (
              <Button
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setCollapsed(!collapsed)}
                aria-label="菜单"
              />
            )}
            <Input
              placeholder="搜索文件名（回车）"
              prefix={<SearchOutlined />}
              style={{ width: isMobile ? '100%' : 320, maxWidth: 480 }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onPressEnter={handleSearch}
              allowClear
            />
          </Space>
          {/* 固定的「上传任务」入口：任务列表常驻，收起/最小化后也能一键打开（v1.1.6） */}
          <Space size={4}>
            <UploadTaskButton />
            <Dropdown menu={userMenu} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size="small" style={{ background: '#1677ff' }} icon={<UserOutlined />} />
                {!isMobile && <span>{user?.displayName || user?.username}</span>}
                {!isMobile && (
                  <Tag color={user?.role === 1 ? 'gold' : user?.role === 2 ? 'blue' : 'default'}>
                    {user ? ROLE_NAMES[user.role] : ''}
                  </Tag>
                )}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        {/* 内容区 + 右侧上传常驻栏（v1.1.7：占位式，不覆盖文件列表；无任务时自动消失） */}
        <Layout hasSider>
          <Content style={{ overflow: 'auto', padding: isMobile ? 8 : 16 }}>
            <Suspense fallback={null}>
              <UploadResumeButton />
            </Suspense>
            <Outlet />
          </Content>
          <UploadQueue />
        </Layout>
      </Layout>
    </Layout>
  );
}
