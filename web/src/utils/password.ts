// 密码强度前端校验：与后端 security.service.ts 的 validatePasswordStrength 完全一致
// 规则：≥8 位，且字符种类 ≥2（字母 / 数字 / 特殊符号 三类中至少两类）
export function validatePasswordStrength(password: string): string | null {
  if (!password) return '请输入密码';
  if (password.length < 8) return '密码至少 8 位';
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  const kinds = (hasLetter ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSymbol ? 1 : 0);
  if (kinds < 2) return '密码需同时包含字母与数字（建议含特殊符号）';
  return null;
}

/** antd Form.Item rule：密码强度校验（供注册/改密/找回页面复用，与后端一致） */
export const passwordStrengthRule = {
  validator: (_: unknown, v: string): Promise<void> => {
    const err = validatePasswordStrength(v);
    if (err) return Promise.reject(new Error(err));
    return Promise.resolve();
  },
} as const;
