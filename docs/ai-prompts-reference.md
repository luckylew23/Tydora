# AI 提示词参考 — soloMD 与 BrainyAI 提取对照

> 从两个源项目提取的全部 AI 提示词原文，供 Tydora 动作提示词（`providers.ts` 的 ACTIONS）调优参考。
> 提取时间：2026-11-13。`{{TEXT}}` / `{{LANG}}` / `{{QUOTE}}` 为原文的运行时占位符（选中文本 / 输出语言 / 页面内容）。

## 一、soloMD（`app/src/lib/ai-providers.ts`）

结构：每个动作 = system 角色声明 + user 指令；**提示词全英文**（唯一直接写死中文的是译中动作）。

### 角色声明（system）

| 角色 | 原文 |
|---|---|
| EDITOR_ROLE（改写/精简/扩写/自定义共用） | You are an expert editor. Reply with only the rewritten text — no preamble, no explanations, no markdown fences. |
| TRANSLATOR_ROLE（翻译） | You are a professional translator. Reply with only the translated text — preserve markdown formatting, links, and code blocks. No preamble. |
| EXPLAINER_ROLE（解释） | You are a knowledgeable tutor. Explain the given text clearly and concisely. Use plain prose; no markdown headings. |

### 动作指令（user）

| 动作 | 指令原文 |
|---|---|
| 改写 rewrite | Rewrite the following text to improve clarity and flow while keeping the meaning and tone. Reply with only the rewritten text. |
| 精简 shorten | Rewrite the following text in fewer words while keeping the meaning. Reply with only the rewritten text, no preamble. |
| 扩写 expand | Expand the following text with more detail and context while keeping the original tone. Reply with only the expanded text. |
| 译英 translateEn | Translate the following text to natural, idiomatic English. Reply with only the translation. |
| 译中 translateZh | 把下面这段文字翻译成自然、流畅的中文。只回复译文,不要其他说明。（唯一中文指令） |
| 解释 explain | Explain the following text in plain language for a general reader. Reply with only the explanation. |
| 自定义 custom | （空，用户输入透传） |

**特点**：无输出语言跟随规则——中文输入配英文指令时输出常变英文（Tydora 已修：system 加语言跟随 + 指令中文化）。

## 二、BrainyAI

BrainyAI 的提示词分三处：`libs/prompt.ts`（6 个格式化函数，`{{LANG}}` 语言占位 + `{{QUOTE}}` 页面内容）、`options/constant/PromptDatas.tsx`（提示词卡片）、PDF/图片专属卡。共同模式：**先声明角色任务 → "no need to repeat what I asked"（不复述问题）→ 输出语言用 `{{LANG}}` 占位注入**。

### 2.1 格式化函数（libs/prompt.ts）— 侧边栏交互用

| 功能 | 指令原文（`{{LANG}}`=输出语言，`{{QUOTE}}`=页面内容，`{{TEXT}}`=选中文本） |
|---|---|
| AskAI 问答 | Your role is an AI assistant, proficient in solving various problems. Remember, no need to repeat what i asked. Answer this following question and respond in the {{LANG}} language: the background and my question is {{QUOTE}}, {{TEXT}}. |
| 翻译 Translate | I want you to act as an {{LANG}} translator, spelling corrector and improver. Remember, no need to repeat what i asked. Translate {{TEXT}} into {{LANG}}. |
| 总结 Summary | I want you to act as a text summarizer to help me create a concise summary of the text I provide. The summary expressing the key points and concepts written in the original text without adding your interpretations. Please respond in the {{LANG}}. My first request is: {{QUOTE}} {{TEXT}}. |
| 解释 Explain | I want you to act as a simple explanation provider for difficult concepts. I will provide a brief description of a concept, and you will respond with a clear and concise explanation in layman's terms. Your response should not include technical language or complex terminology. Instead, you must focus on breaking down the concept into easy-to-understand language. Remember, only respond in {{LANG}} language, no need to repeat what i asked. My first request is: {{QUOTE}} {{TEXT}} |
| 改述 Rephrase | Rephrase the paragraph, focusing on the core topic. Please respond in the {{LANG}}. The paragraph is: {{QUOTE}} {{TEXT}}. |
| 语法检查 GrammarCheck | Your role is a spoken {{LANG}} teacher and improver. You will reply to me in {{LANG}}. I want you to strictly correct my grammar mistakes, typos, and factual errors. Remember, no need to repeat what i asked. My first sentence is {{QUOTE}} {{TEXT}}. |

### 2.2 提示词卡片（PromptDatas.tsx）— 设置页可编辑的默认卡片

| 卡片 | 指令原文（`{{TEXT}}`=选中文本/页面内容，`{{LANG}}`=输出语言） |
|---|---|
| Translate 翻译 | I would like you to translate the text delimited by triple quotes into {{LANG}} language, ensuring that the translation is colloquial and authentic. Only give me the output and nothing else. Do not wrap responses in quotes. """ {{TEXT}} """ |
| Condense 精简（id 1013） | Condense the following paragraph: {{TEXT}}. Please respond in {{LANG}}. |
| Outline 大纲（页面级） | Organize the following content into a clear hierarchical outline in Markdown format: use headings for main topics and nested bullet points for subtopics and key details. Keep it concise and faithful to the original content: {{TEXT}}. Please respond in {{LANG}}. |
| Mindmap 思维导图（页面级） | Create a text-based mind map of the following content in Markdown format: start with the central topic as the root node, then use nested bullet points to represent branches and sub-branches, keeping each node short: {{TEXT}}. Please respond in {{LANG}}. |
| Explain 解释 | Clarify and explain the following paragraph: {{TEXT}}. Please respond in {{LANG}}. |
| Rephrase 改述 | Rephrase the following paragraph: {{TEXT}}. Please respond in {{LANG}}, focusing on the core topic. |
| Grammar check 语法检查 | Correct grammar mistakes, typos, and factual errors of the following paragraph: {{TEXT}}. Please respond in {{LANG}}, focusing on the core topic. |
| AskAI（默认快捷） | 字面文本 "AskAI"（纯触发，不带指令） |

### 2.3 PDF 阅读专属卡（PdfPromptDatas）

| 卡片 | 指令原文 |
|---|---|
| 摘要 | Provide a 3-5 sentence summary that captures the key points and main takeaways from this file. |
| Key Points 要点 | {{TEXT}} 5 key points in this file by identifying 5 important points or takeaways. Ensure that the key points accurately capture the main ideas, concepts, and insights from the text in a succinct way. Avoid redundancy and focus on highlighting the most crucial and relevant information. Please use the following format: Key Point 1: … Key Point 5: |
| Quiz 测验 | Based on this file, please generate 5 sets of quiz questions and answers. The questions should cover the key information and important concepts in the text. Ensure that the questions and answers are concise and easy to understand. Each question should have one correct answer. Please provide the quiz content in the following format: Quiz N: Question: Answer; |

### 2.4 图片专属卡（ImagePromptDatas）

| 卡片 | 指令原文 |
|---|---|
| Describe | Describe this Image |
| Grab Text | Extract text from this image |
| Extract & Translate | Extract text from this image and then translate into English |

## 三、两者对比与 Tydora 可借鉴点

| 维度 | soloMD | BrainyAI | Tydora 现状 |
|---|---|---|---|
| 提示词语言 | 全英文（译中一条中文） | 全英文 + `{{LANG}}` 占位注入输出语言 | 全中文 + system 语言跟随规则 |
| 输出语言控制 | 无显式规则（中文输入会被英文指令带偏） | `{{LANG}}` 显式注入（语言由 UI 语言决定，非输入语言） | system 硬性规则「跟随输入语言」（翻译定向） |
| 不复述问题 | 无 | "no need to repeat what I asked" | 无（可借鉴：减少输出废话） |
| 页面级动作（大纲/思维导图） | 无 | Outline / Mindmap 卡（页面内容结构化） | 无（候选：全文→大纲/思维导图 md） |
| PDF 阅读卡 | 无 | 摘要 / 要点 / 测验 | 无（候选） |
| 图片理解卡 | 无 | 图片描述 / 抓取文字 / 图文翻译 | 无（需要多模态 provider） |
| 输出格式约束 | "no markdown fences" | 三引号定界防包引号 | system 无 fences 约束（可借鉴） |

**值得 Tydora 吸收的提示词技巧**：

1. BrainyAI 的 **"no need to repeat what I asked"**——抑制模型复述问题，配合流式输出体验更好。
2. 翻译卡的 **三引号定界**（`""" {{TEXT}} """`）+ "Do not wrap responses in quotes"——防止模型把译文包进引号。
3. **大纲/思维导图 Markdown 结构化卡**——与 Tydora 的 md 编辑器场景天然契合，适合作为「全文处理」新动作。
4. PDF 卡的 **格式化输出模板**（Key Point 1: … / Quiz 1: …）——约束输出结构，总结/要点类动作可借鉴「要点 N:」格式。
5. `{{LANG}}` 显式注入 vs Tydora 的「跟随输入语言」规则：两者互补——跟随规则处理正文语言，显式注入处理用户想要的目标语言（如英文界面下要求中文输出）。
