import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 84 · D1：组件渲染测试放 `web/tests/**`（复用 web 包已装好的 react/tea-component 等运行时，
    // 零新运行依赖）；纯逻辑用例保持 `tests/**/*.test.ts` 原样。
    // 环境仍是 **全局 node**，组件用例在**文件内**声明 `// @vitest-environment jsdom`（per-file，
    // 不动既有 6 个纯逻辑文件）。
    include: ['tests/**/*.test.ts', 'web/tests/**/*.test.tsx'],
    environment: 'node',
    server: {
      deps: {
        // 76 · S7-c：better-sqlite3 是 native CJS——走 vitest 转换管道会找不到 bindings，
        // 必须外置（原生 require）。
        external: ['better-sqlite3'],
      },
    },
  },
  resolve: {
    alias: {
      // 76 · S7-c：web 纯函数（view-model / i18n 字典）在 node 环境直测（同 web tsconfig 的 paths）。
      '@': resolve(__dirname, 'web/src'),
    },
  },
});
