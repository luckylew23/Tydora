/**
 * 清理「AI 痕迹」——LLM 常见污染字符的轻量清洗（对照移植 soloMD clean-ai.ts）。
 *
 * 处理：AI 引用标记（Gemini/ChatGPT/Perplexity 等）、零宽/双向控制字符、
 * 不换行空格、智能引号、长破折号、省略号、行尾空白、连续空行。
 * 保留 Markdown 结构；纯本地转换、无网络请求。
 */

export function cleanAIArtifacts(text: string): string {
  if (!text) return text;

  return (
    text
      // ===== AI 引用/来源标记 =====
      // Gemini / Google AI / NotebookLM
      .replace(/\[cite_start\]/gi, "")
      .replace(/\[cite:\s*[\d,\s]+\]/gi, "")
      // ChatGPT 联网引用：【1†source】【oai_citation:1|title】
      .replace(/【[^】]*†[^】]*】/g, "")
      .replace(/【oai_citation:[^】]*】/g, "")
      .replace(/【\d+:\d+†[^】]*】/g, "")
      // Perplexity 风格句尾引用簇 [1][2][3]（非 Markdown 脚注）
      .replace(/(?<=\S)\s*\[\d+\](?:\s*\[\d+\])*/g, "")
      // 文末 "Sources:" / "References:" 块
      .replace(/\n{2,}(?:Sources?|References?|Citations?):\s*\n[\s\S]*$/i, "")

      // ===== Unicode 归一化 =====
      // BOM
      .replace(/^\uFEFF/, "")
      // 零宽 / 双向 / 格式控制字符
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      // 不换行空格 → 普通空格
      .replace(/\u00A0/g, " ")
      // 智能双引号 → 直引号
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      // 智能单引号 → 直引号
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      // en dash → 连字符
      .replace(/\u2013/g, "-")
      // em dash → " - "
      .replace(/\u2014/g, " - ")
      // 省略号 → ...
      .replace(/\u2026/g, "...")

      // ===== 空白清理 =====
      // 行尾空白
      .replace(/[ \t]+$/gm, "")
      // 3+ 连续空行 → 2
      .replace(/\n{3,}/g, "\n\n")
      // 词间多空格 → 1（保留缩进）
      .replace(/(\S) {2,}(\S)/g, "$1 $2")
  );
}
