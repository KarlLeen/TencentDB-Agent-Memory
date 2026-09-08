/**
 * asset-refs — metadata.assets 的类型与纯工具。
 *
 * 契约见 docs/implementation/15-injector-asset-metadata.md §4：
 *   - InjectedAssetRef：真实资产身份 + 方案1文本锚（block.content 内的区间）
 *   - joinLinesWithOffsets / spanOfLines：注入块"逐行组装 + join('\n')"时零成本拿 spans
 *   - validateAssets：不变式（assetId 不重复 / spans 不重叠且界内）的校验器（测试用）
 *
 * 只被四个产资产 injector 使用；静态能力文档块（skill-tools 等）不挂 assets。
 */
export const INJECTED_ASSET_TYPES = ["skill", "llm_wiki", "code_graph", "chat_memory"] as const;
export type InjectedAssetType = (typeof INJECTED_ASSET_TYPES)[number];

/** `block.content` 上的半开区间 [start, end)。只相对该 block 自洽，不承诺 prompt 全局偏移。 */
export interface AssetTextSpan {
  start: number; // 含
  end: number; // 不含；<= content.length
}

export interface InjectedAssetRef {
  /** 真实资产 id（10-event-table §4.1）：skill_id / knowledge_id / chat_memory-{teamId}-{agentId}。绝不自造。 */
  assetId: string;
  assetType: InjectedAssetType;
  /** 展示名（agentName / knowledge name / skill name）。只读辅助，不作唯一键（可能重复）。 */
  name?: string;
  /** 版本：生产方手头本来就有才带（skill = hits.version）；没有就省，消费端需要时经 meta 回查。 */
  version?: number;
  /** 方案1文本锚：该资产渲染文本在 block.content 里的区间。一个资产出现多次合并为一段。 */
  spans?: AssetTextSpan[];
  /** spans 覆盖的渲染文本被注入器截断过（当前仅 profile 的 L3 truncate）。 */
  truncated?: boolean;
}

/**
 * `join('\n')` 的字节等价物，同时返回每行起始 offset（供 spans 计算）。
 * lines 为空时 content 为 ""、offsets 为 []（`[].join("\n")` 语义一致）。
 */
export function joinLinesWithOffsets(lines: string[]): { content: string; offsets: number[] } {
  const offsets: number[] = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = pos;
    pos += lines[i].length + (i < lines.length - 1 ? 1 : 0);
  }
  return { content: lines.join("\n"), offsets };
}

/** 由行区间 [first, last]（含）求 char 区间。 */
export function spanOfLines(
  offsets: number[],
  lines: string[],
  first: number,
  last: number,
): AssetTextSpan {
  return { start: offsets[first], end: offsets[last] + lines[last].length };
}

/**
 * 校验不变式（15-injector-asset-metadata.md §4.5 的 1/2/3）：
 *   - assetId 非空且不重复
 *   - spans 全部在 content 界内、非空、互不重叠、按 start 升序
 * 返回错误信息数组（空 = 通过）。
 */
export function validateAssets(content: string, assets: InjectedAssetRef[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const allSpans: Array<{ assetId: string; span: AssetTextSpan }> = [];

  for (const ref of assets) {
    if (!ref.assetId) {
      errors.push("empty assetId");
      continue;
    }
    if (seen.has(ref.assetId)) {
      errors.push(`duplicate assetId: ${ref.assetId}`);
    }
    seen.add(ref.assetId);

    const spans = ref.spans ?? [];
    for (const span of spans) {
      if (span.start < 0 || span.end < span.start || span.end > content.length) {
        errors.push(
          `span out of bounds asset=${ref.assetId} [${span.start},${span.end}) len=${content.length}`,
        );
        continue;
      }
      if (span.end === span.start) {
        errors.push(`empty span text asset=${ref.assetId} [${span.start},${span.end})`);
        continue;
      }
      allSpans.push({ assetId: ref.assetId, span });
    }
  }

  // 排序后检查重叠（含相邻触碰：前一段 end > 后一段 start 即重叠）
  allSpans.sort((a, b) => a.span.start - b.span.start);
  for (let i = 1; i < allSpans.length; i++) {
    const prev = allSpans[i - 1];
    const cur = allSpans[i];
    if (cur.span.start < prev.span.end) {
      errors.push(`overlapping spans asset=${cur.assetId} vs ${prev.assetId}`);
    }
  }

  return errors;
}
