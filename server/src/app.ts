// Express 应用装配
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config/index.js';
import { errorMiddleware } from './lib/errors.js';
import { csrfProtect } from './lib/csrf.js';
import { appRoutes, protectedRoutes } from './routes/index.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // 安全头（CSP 关闭：需要加载同源静态资源与签名 URL 图片/PDF 预览）
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(compression());
  app.use(cookieParser(config.cookieSecret));
  app.use(express.json({ limit: '1mb' }));

  // 开发模式跨域（生产同源由 Nginx 反代，无需 CORS）
  if (config.corsOrigin) {
    const origins = config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
    app.use(cors({ origin: origins, credentials: true }));
  }

  // 免 CSRF 路由（health / auth）
  app.use(config.apiPrefix, appRoutes);

  // 业务路由：全量 CSRF 双重提交校验
  app.use(config.apiPrefix, csrfProtect, protectedRoutes);

  // 404
  app.use((req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.path}` });
  });

  app.use(errorMiddleware);
  return app;
}
