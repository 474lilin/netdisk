// =============================================================================
// LDAP / AD 企业域账号对接：预留接口与占位实现
// 企业可在不改造业务代码的前提下接入内部账号体系：
//   1. 实现 AuthProvider 接口
//   2. 在 index.ts 的 createAuthProvider() 中启用
//   3. 通过 .env 的 LDAP_* 配置项驱动（离线内网 LDAP 服务）
// =============================================================================
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { verifyPassword } from '../lib/password.js';
import { queryOne } from '../db/pool.js';
import type { UserRow } from '../types/index.js';

export interface LdapUserInfo {
  username: string;
  displayName: string;
  email: string;
  ldapDn: string;
}

export interface AuthProvider {
  readonly name: 'local' | 'ldap' | 'ad';
  /** 校验账号密码；本地实现返回 DB 用户，LDAP 实现负责域认证 + 本地用户映射 */
  authenticate(username: string, password: string): Promise<UserRow | null>;
  /** 同步/预建 LDAP 用户（可选） */
  syncUser?(info: LdapUserInfo): Promise<void>;
}

// ---------- 本地账号密码认证（默认） ----------
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local' as const;

  async authenticate(username: string, password: string): Promise<UserRow | null> {
    const user = await queryOne<UserRow>(
      `SELECT * FROM users WHERE username = $1 AND auth_source = 'local' AND status = 1`,
      [username]
    );
    if (!user) return null;
    const ok = await verifyPassword(password, user.password_hash);
    return ok ? user : null;
  }
}

// ---------- LDAP / AD 域认证占位 ----------
// 说明：当前为接口占位 + 配置校验。企业接入时：
//   - 引入 ldapjs（纯 JS，支持离线 npm 私服）：
//       import ldap from 'ldapjs';
//   - 在 authenticate() 中执行 bind 校验（ldap_url / bind_dn / user_filter）
//   - bind 成功后按 LDAP_BASE_DN + LDAP_USER_FILTER 搜索用户属性
//   - 返回或按需 syncUser() 创建本地账号（auth_source='ldap'，role 默认员工）
export class LdapAuthProvider implements AuthProvider {
  readonly name: 'ldap' | 'ad';

  constructor(kind: 'ldap' | 'ad' = 'ldap') {
    this.name = kind;
  }

  async authenticate(_username: string, _password: string): Promise<UserRow | null> {
    if (!config.ldap.enabled) {
      logger.warn('LDAP auth called but LDAP_ENABLED=false');
      return null;
    }
    if (!config.ldap.url) {
      logger.error('LDAP_ENABLED=true 但未配置 LDAP_URL');
      return null;
    }
    // TODO(企业接入点): 实现 ldapjs bind + search + 用户映射
    // 示例：
    //   const client = ldap.createClient({ url: config.ldap.url });
    //   await bind(client, config.ldap.bindDn, config.ldap.bindPassword);
    //   const filter = config.ldap.userFilter.replace('%s', escape(username));
    //   const { searchEntries } = await search(client, config.ldap.baseDn, filter);
    //   if (searchEntries.length === 0) return null;
    //   const dn = searchEntries[0].dn;
    //   await bind(client, dn, password);  // 用户域密码校验
    //   本地映射: upsert users(username, auth_source='ldap', ldap_dn=dn)
    throw new Error('LDAP 认证未实现：请按 server/src/ldap/provider.ts 中的 TODO 接入企业 LDAP/AD');
  }
}

let provider: AuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (!provider) {
    provider = config.ldap.enabled && config.ldap.url ? new LdapAuthProvider('ldap') : new LocalAuthProvider();
  }
  return provider;
}

export function ldapStatus(): { enabled: boolean; configured: boolean; url: string } {
  return {
    enabled: config.ldap.enabled,
    configured: Boolean(config.ldap.url),
    url: config.ldap.url,
  };
}
