/**
 * 76 · S7-c：dev 夹具安全守卫（C7；**R4 反向控制钉点**）。
 *
 * ⚠️ 这里只测守卫与"缺表明确报错"——**绝不在测试里写入默认真库**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertSafeTarget, defaultDbPath, seed } from '../../scripts/seed-attribution-dev.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('76 · C7 夹具安全：默认库拒绝 / 临时库放行 / 缺表明确报错', () => {
  it('assertSafeTarget 拒绝默认库（R4 钉点）', () => {
    const target = defaultDbPath();
    console.log(`SG1 → 目标=${target}`);
    expect(() => assertSafeTarget(target)).toThrow(/seed-guard/);
    // 变体：HOME 拼接的等价路径同样被拒（resolve 后比较）
    expect(() => assertSafeTarget(path.join(os.homedir(), '.tdai-memory-proxy', 'proxy.db'))).toThrow();
  });

  it('临时库放行；空库 ⇒ 明确报错（要求先初始化 schema，不静默）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-seed-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'proxy.db');
    expect(assertSafeTarget(dbPath)).toBe(path.resolve(dbPath));
    // 全新建的空库（无表）⇒ 明确报错（含"先启动一次 proxy/worker"指引）
    expect(() => seed(dbPath)).toThrow(/缺表|初始化 schema/);
  });
});
