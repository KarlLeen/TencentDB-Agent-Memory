import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "packages/**/src/__tests__/**/*.test.ts", "packages/**/src/**/__tests__/**/*.test.ts"],
    // 73 · C1：每个测试文件独享临时库（裸跑不可能发生；真库守卫见 db/index.ts）。
    setupFiles: ["src/__tests__/setup/isolate-db.ts"],
  },
  resolve: {
    alias: {
      "@context-proxy/cost-guard": resolve(__dirname, "packages/cost-guard/src/index.ts"),
    },
  },
});
