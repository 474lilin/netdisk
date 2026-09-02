// JWT 双令牌：Access Token（内存，短时）+ Refresh Token（httpOnly Cookie，可吊销）
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import type { JwtPayload } from '../types/index.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  accessExpiresIn: number; // 秒
  refreshExpiresIn: number; // 秒
}

function expiresSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 1800;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 1800;
  }
}

export function signAccessToken(user: { id: string; orgId: string; role: number; username: string }): string {
  const payload: JwtPayload = {
    sub: user.id,
    org: user.orgId,
    role: user.role,
    name: user.username,
    typ: 'access',
  };
  const opts: jwt.SignOptions = { expiresIn: config.jwtAccessTtl as jwt.SignOptions['expiresIn'], issuer: 'minio-netdisk' };
  return jwt.sign(payload, config.jwtAccessSecret, opts);
}

export function signRefreshToken(userId: string, sessionId: string): string {
  const payload: JwtPayload = {
    sub: userId,
    org: '',
    role: 3,
    name: '',
    typ: 'refresh',
  };
  const opts: jwt.SignOptions = { expiresIn: config.jwtRefreshTtl as jwt.SignOptions['expiresIn'], issuer: 'minio-netdisk' };
  return jwt.sign({ ...payload, sid: sessionId } as never, config.jwtRefreshSecret, opts);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtAccessSecret, { issuer: 'minio-netdisk' }) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload & { sid?: string } {
  return jwt.verify(token, config.jwtRefreshSecret, { issuer: 'minio-netdisk' }) as JwtPayload & { sid?: string };
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function issueTokenPair(user: { id: string; orgId: string; role: number; username: string }, sessionId: string): TokenPair {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user.id, sessionId);
  return {
    accessToken,
    refreshToken,
    refreshTokenHash: hashRefreshToken(refreshToken),
    accessExpiresIn: expiresSeconds(config.jwtAccessTtl),
    refreshExpiresIn: expiresSeconds(config.jwtRefreshTtl),
  };
}

// CSRF Token：登录/刷新后写入非 httpOnly Cookie（双重提交模式）
export function generateCsrfToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
