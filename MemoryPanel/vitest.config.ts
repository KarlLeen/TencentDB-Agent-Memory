import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
