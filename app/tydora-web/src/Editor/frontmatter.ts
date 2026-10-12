// ── YAML Frontmatter 解析工具 ──

export interface FrontmatterData {
  [key: string]: unknown;
}

/**
 * Frontmatter 围栏正则 —— 全项目唯一副本。
 *
 * `Editor/extensions/frontmatter.ts`（markdown-it 解析规则）、`extractFrontmatter`
 * 与 `tags/TagIndexService.ts` 必须共用这一份：历史上各自存了一份，只改一处就会
 * 让「编辑器识别出的元数据块」与「标签/图谱提取到的元数据」结果不一致。
 *
 * 每段设计都对应一个已修缺陷，勿简化：
 * - `[ \t\r]*\n`：开围栏独占一行（允许行尾空格/Tab）。`\r` 是必要的 ——
 *   `extractFrontmatter` / `TagIndexService` 直接吃文件原文，不经过 markdown-it
 *   的 CRLF 归一化。
 * - `[\s\S]*?`：懒惰匹配到**第一个**闭围栏；内容可为空、可含空行。
 * - `(?:\r?\n)?---`：闭围栏前的换行**可选**。缺了它，空元数据 `---\n---` 识别不了，
 *   会退化成两条水平线（Rust 侧 `frontmatter::split` 是逐行扫描，本来就认，
 *   两边会出现 GUI 显示两条线、CLI 却认为有 frontmatter 的分裂）。
 * - `(?:\r?\n|$)`：闭围栏后允许「换行」或「文件结束」。末尾强制 `\n` 会让以 `---`
 *   结尾且无尾换行的文件（脚本/其它工具常见的写法）识别失败 —— `---` 被当成 hr、
 *   正文被当成 setext H2 下划线，保存即损坏元数据。
 */
export const FRONTMATTER_RE =
  /^---[ \t\r]*\n([\s\S]*?)(?:\r?\n)?---[ \t\r]*(?:\r?\n|$)/;

export function extractFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = markdown.match(FRONTMATTER_RE);
  if (match) {
    return {
      frontmatter: match[1],
      body: markdown.slice(match[0].length),
    };
  }
  return { frontmatter: null, body: markdown };
}

// ── HTML 转义 ──
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把 Markdown 开头的 frontmatter 围栏改写成编辑器可识别的 HTML 占位块
 * （`<div data-type="frontmatter">`），后接正文。没有 frontmatter 时返回 `null`。
 *
 * ⚠️ 换行必须编码成字符实体 `&#10;`，让占位块保持**单行**。
 *
 * markdown-it 的 html_block 规则（CommonMark type 6，`<div` 属块级标签）遇到空行
 * 即结束该块。若把 YAML 原样（含真实换行）注入，元数据里只要有一个空行，
 * `<div data-type="frontmatter">` 就会被提前闭合：闭围栏与后面的元数据行溢出成
 * 正文段落 —— IR 模式下元数据框只剩前半截、剩余键值变成普通段落，切回源码保存
 * 即损坏元数据（实测 `---\ntitle: a\n\ntags: b\n---` → `---\ntitle: a\n---\n\ntags: b`）。
 *
 * 编码后整个 div 落在同一行内；TipTap 的 DOMParser 解析 HTML 时会把实体还原成
 * 真实换行，文本内容一字不差。`escapeHtml` 先做，`&#10;` 后加，顺序不能反。
 */
export function rewriteFrontmatterAsHtml(src: string): string | null {
  const match = src.match(FRONTMATTER_RE);
  if (!match) return null;
  const placeholder =
    `<div data-type="frontmatter">` +
    escapeHtml(match[1]).replace(/\n/g, "&#10;") +
    `</div>\n\n`;
  return placeholder + src.slice(match[0].length);
}

/** 简单 YAML 解析（仅支持标量键值对，无需外部依赖） */
export function parseFrontmatter(yaml: string): FrontmatterData {
  const result: FrontmatterData = {};
  const lines = yaml.split("\n");
  for (const line of lines) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (m) {
      const key = m[1];
      let value: string = m[2].trim();
      // 移除引号包裹
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}
