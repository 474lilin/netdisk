// 注册 TS 解析钩子（配合 e2e/ts-resolver.mjs）
import { register } from 'node:module';
register('./ts-resolver.mjs', import.meta.url);
