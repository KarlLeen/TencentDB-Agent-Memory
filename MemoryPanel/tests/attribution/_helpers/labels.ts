/**
 * 126 · 渲染级词表（zh 渲染不得出现；en 渲染不得出现 CJK）。
 * 独立 helper：避免测试文件互相 import（vitest 收集/顺序副作用）。
 */
export const EN_UI_WORDS = [
  'Units',
  'Judged',
  'used',
  'corrected',
  // 'pending' 例外：zh 溢出句为 30 spec 原文（"保持 pending，下轮 FIFO 优先"），含该英文词属原文契约。
  'failed',
  'Unit',
  'Verdict',
  'Turn',
  'Markers',
  'Status events',
] as const;
