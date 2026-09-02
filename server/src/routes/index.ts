// 路由汇总（拆分为 免CSRF 与 需CSRF 两组，见 app.ts 装配顺序）
import { Router } from 'express';
import authRouter from './auth.js';
import healthRouter from './health.js';
import orgRouter from './org.js';
import usersRouter from './users.js';
import filesRouter from './files.js';
import shareRouter, { publicShareRouter } from './share.js';
import searchRouter from './search.js';
import auditRouter from './audit.js';
import quotaRouter from './quota.js';
import monitorRouter from './monitor.js';

// 免 CSRF：健康检查（GET 安全）+ 认证（首次登录尚无 CSRF Cookie，负责下发）
//           + 分享公开访问（令牌本身就是授权凭据）
export const appRoutes: Router = Router();
appRoutes.use('/health', healthRouter);
appRoutes.use('/auth', authRouter);
appRoutes.use('/shares', publicShareRouter);

// 需 CSRF：业务接口
export const protectedRoutes: Router = Router();
protectedRoutes.use('/org', orgRouter);
protectedRoutes.use('/users', usersRouter);
protectedRoutes.use('/files', filesRouter);
protectedRoutes.use('/shares', shareRouter);
protectedRoutes.use('/search', searchRouter);
protectedRoutes.use('/audit', auditRouter);
protectedRoutes.use('/quota', quotaRouter);
protectedRoutes.use('/monitor', monitorRouter);

export default protectedRoutes;
