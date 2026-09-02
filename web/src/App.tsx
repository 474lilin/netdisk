import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuthStore } from './store/auth';
import LoginPage from './pages/LoginPage';
import MainLayout from './components/Layout/MainLayout';
// 首屏页面（文件浏览）保持静态引入；其余页面按路由懒加载，预览库（pdf/xlsx/docx）随 FilePreview 延迟加载
import FileBrowserPage from './pages/FileBrowserPage';

const TrashPage = lazy(() => import('./pages/TrashPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const ShareLinksPage = lazy(() => import('./pages/ShareLinksPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const ShareViewPage = lazy(() => import('./pages/ShareViewPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuthStore();
  const location = useLocation();
  useEffect(() => {
    if (!ready) void useAuthStore.getState().bootstrap();
  }, [ready]);
  if (!ready) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="加载中...">
          <div style={{ height: 80 }} />
        </Spin>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

// 懒加载路由的统一 Suspense 兜底（chunk 加载期间显示轻量占位，避免白屏）
function PageFallback() {
  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', alignItems: 'center', justifyContent: 'center' }}>
      <Spin size="large" tip="加载中..." />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/share/:token" element={<ShareViewPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route index element={<FileBrowserPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="shares" element={<ShareLinksPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
