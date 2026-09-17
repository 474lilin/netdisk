// 最小 ESM loader：让 Node 原生 TS 类型剥离（Node 22.18+ 默认开启）
// 能够解析仓库源码里的「无扩展名」导入（'../api' / './retry'）——Node ESM 默认要求显式扩展名。
// 背景：本项目在受限环境下无法运行 esbuild/tsx（spawn EPERM），故用 Node 内置能力做逻辑验证。
// 用法： node --import ./e2e/ts-register.mjs e2e/_upload-resilience.ts
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
      const base = path.resolve(parent, specifier);
      const candidates = [base + '.ts', base + '.mts', path.join(base, 'index.ts'), base + '.js'];
      for (const cand of candidates) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}
