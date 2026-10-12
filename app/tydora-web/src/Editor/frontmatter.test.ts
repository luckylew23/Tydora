/**
 * Frontmatter 围栏解析 / HTML 占位块注入单元测试。
 *
 * 回归目标（三个已修缺陷，均属「测试覆盖之外」）：
 *
 * 1. **元数据含空行 → 内容溢出成正文（数据损坏）**
 *    markdown-it 的 html_block 规则（CommonMark type 6，`<div` 属块级标签）遇到空行
 *    即结束块。早期实现把 YAML 原样注入 `<div data-type="frontmatter">…`，于是
 *    元数据里出现一个空行就会把 div 提前闭合 —— IR 模式下元数据框只剩前半截，
 *    剩余键值变成普通段落，切回源码保存即损坏元数据。
 *    实测：`---\ntitle: a\n\ntags: b\n---\n\n正文` → `---\ntitle: a\n---\n\ntags: b\n\n正文`
 *    修法：YAML 的换行编码为 `&#10;`，占位块保持单行；DOM 解析时实体还原为换行。
 *
 * 2. **空元数据 `---\n---` 被当成两条水平线**
 *    原正则要求闭围栏前必须有换行，`---\n---` 匹配不上 → 退化成 `hr + hr`，
 *    METADATA 卡片凭空消失；且与 `---\n\n---` 之间来回漂移。
 *    Rust 侧 `frontmatter::split` 是逐行扫描、本来就认，前后端判定分裂。
 *
 * 3. **闭围栏必须是文件结尾且无尾换行时识别失败**
 *    原正则末尾强制 `\n`，`---\ntitle: x\n---`（EOF 结束）识别不了 → `---` 被当成
 *    hr、正文被当成 setext H2 下划线，保存后元数据损坏。
 *
 * 运行：node --experimental-strip-types app/tydora-web/src/Editor/frontmatter.test.ts
 */
import markdownit from "markdown-it";
import {
  FRONTMATTER_RE,
  extractFrontmatter,
  rewriteFrontmatterAsHtml,
} from "./frontmatter.ts";

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(
      `  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`,
    );
  }
}

/** 取占位块 `<div …>` 与 `</div>` 之间的原始文本（未解码） */
function divInner(html: string): string {
  const start = html.indexOf(">") + 1;
  const end = html.indexOf("</div>");
  return html.slice(start, end);
}

/** DOM 解析时字符实体会被还原成真实字符，这里等价复原以便比对 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

console.log("── extractFrontmatter / FRONTMATTER_RE：围栏边界 ──");
{
  const normal = extractFrontmatter("---\ntitle: hello\ntags: a, b\n---\n\n正文");
  eq(normal.frontmatter, "title: hello\ntags: a, b", "普通元数据");
  eq(normal.body, "\n正文", "普通元数据：正文切分正确");

  const blank = extractFrontmatter("---\ntitle: hello\n\ntags: a, b\n---\n\n正文");
  eq(blank.frontmatter, "title: hello\n\ntags: a, b", "★ 空行：内容完整（此前被截断）");
  eq(blank.body, "\n正文", "★ 空行：正文不含元数据残留");

  const empty = extractFrontmatter("---\n---\n\n正文");
  eq(empty.frontmatter, "", "★ 空元数据 ---\\n---：识别为空 frontmatter（此前为 null）");
  eq(empty.body, "\n正文", "★ 空元数据：正文正确");

  const emptyBlank = extractFrontmatter("---\n\n---\n\n正文");
  eq(emptyBlank.frontmatter, "", "空元数据 + 空行：同样识别为空 frontmatter");

  const eof = extractFrontmatter("---\ntitle: x\n---");
  eq(eof.frontmatter, "title: x", "★ 闭围栏即文件结尾（无尾换行）");
  eq(eof.body, "", "★ 闭围栏即文件结尾：正文为空");

  const crlf = extractFrontmatter("---\r\ntitle: x\r\ntags: a\r\n---\r\n\r\n正文");
  eq(crlf.frontmatter, "title: x\r\ntags: a", "CRLF：内容不带尾随 \\r");
  eq(crlf.body, "\r\n正文", "CRLF：正文切分正确");

  const unclosed = extractFrontmatter("---\ntitle: x");
  eq(unclosed.frontmatter, null, "未闭合围栏：不算 frontmatter");
  eq(unclosed.body, "---\ntitle: x", "未闭合围栏：原文返回");

  eq(extractFrontmatter("无围栏正文").frontmatter, null, "无围栏：null");
  eq(extractFrontmatter("----\ntitle: x\n----").frontmatter, null, "四个短横不是围栏");

  // 共享同一实例：非 global 正则无 lastIndex 状态，重复调用结果必须一致
  eq(FRONTMATTER_RE.test("---\na: 1\n---"), true, "共享正则首次调用");
  eq(FRONTMATTER_RE.test("---\na: 1\n---"), true, "共享正则重复调用（无状态残留）");

  // 修改任意一段都会静默改变行为：只有第一个闭围栏生效
  const twoFences = extractFrontmatter("---\na: 1\n---\nb: 2\n---\n");
  eq(twoFences.frontmatter, "a: 1", "多个闭围栏：只认第一个");
  eq(twoFences.body, "b: 2\n---\n", "多闭围栏：其余留给正文");
}

console.log("\n── rewriteFrontmatterAsHtml：占位块必须是单行 ──");
{
  const cases: Array<[string, string, string]> = [
    ["普通", "---\ntitle: hello\ntags: a, b\n---\n\n正文", "title: hello\ntags: a, b"],
    ["★ 含一个空行", "---\ntitle: hello\n\ntags: a, b\n---\n\n正文", "title: hello\n\ntags: a, b"],
    ["★ 含两个空行", "---\ntitle: hello\n\n\ntags: a, b\n---\n\n正文", "title: hello\n\n\ntags: a, b"],
    ["★ 空元数据", "---\n---\n\n正文", ""],
    ["★ 无尾换行", "---\ntitle: x\n---", "title: x"],
    ["含 HTML 特殊字符", '---\ntitle: <a href="x">&amp;</a>\n---', 'title: <a href="x">&amp;</a>'],
  ];

  for (const [label, src, expectedYaml] of cases) {
    const out = rewriteFrontmatterAsHtml(src);
    if (out === null) {
      failed++;
      console.error(`  ✗ ${label}: 未识别出 frontmatter`);
      continue;
    }
    const inner = divInner(out);
    eq(inner.includes("\n"), false, `${label}：占位块内容无裸换行（html_block 不会被截断）`);
    eq(decodeEntities(inner), expectedYaml, `${label}：解码后与原始 YAML 完全一致`);
    eq(
      out.startsWith('<div data-type="frontmatter">') && out.includes("</div>\n\n"),
      true,
      `${label}：占位块结构正确且以空行与正文分隔`,
    );
  }

  eq(rewriteFrontmatterAsHtml("无围栏正文"), null, "无围栏：返回 null");
  eq(rewriteFrontmatterAsHtml("---\ntitle: x"), null, "未闭合围栏：返回 null");

  const special = rewriteFrontmatterAsHtml('---\ntitle: <b>&"x"\n---')!;
  eq(special.includes("<b>"), false, "YAML 内的 < 被转义（不会注入真实标签）");
  eq(special.includes("&lt;b&gt;"), true, "YAML 内的 < 转义为 &lt;");
}

console.log("\n── markdown-it 解析：占位块必须是同一个 html_block ──");
{
  const md = markdownit({ html: true, breaks: true });

  const check = (label: string, src: string): void => {
    const html = rewriteFrontmatterAsHtml(src);
    if (html === null) {
      failed++;
      console.error(`  ✗ ${label}: 未识别出 frontmatter`);
      return;
    }
    const tokens = md.parse(html, {});
    eq(tokens[0].type, "html_block", `${label}：首个 token 是 html_block`);
    eq(
      tokens[0].content.includes("</div>"),
      true,
      `${label}：闭标签在同一个 html_block 内（div 未被提前闭合）`,
    );
    const leaked = tokens.some(
      (t) => t.type === "inline" && t.content.includes("</div>"),
    );
    eq(leaked, false, `${label}：没有元数据泄漏成正文行`);
  };

  check("普通", "---\ntitle: hello\ntags: a, b\n---\n\n正文");
  check("★ 含一个空行", "---\ntitle: hello\n\ntags: a, b\n---\n\n正文");
  check("★ 含两个空行", "---\ntitle: hello\n\n\ntags: a, b\n---\n\n正文");
  check("★ 空元数据", "---\n---\n\n正文");

  // 反证：若不做实体编码（旧实现），空行会截断 html_block —— 证明该断言确实有效
  const legacy = md.parse('<div data-type="frontmatter">a\n\nb</div>\n\n正文', {});
  eq(legacy[0].content.includes("</div>"), false, "反证：不编码换行时闭标签被挤出首块");
  eq(
    legacy.some((t) => t.type === "inline" && t.content.includes("</div>")),
    true,
    "反证：不编码换行时元数据泄漏成正文",
  );
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;
