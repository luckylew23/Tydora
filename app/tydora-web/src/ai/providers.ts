/**
 * AI provider 目录 + 动作表（对照移植自 soloMD `ai-providers.ts`，裁剪至
 * Tydora P0 的 3 家）。
 *
 * - `PROVIDERS`：设置面板 AI 页签里可选的服务商。API key 只存 OS 钥匙串
 *   （Rust 侧 `ai_commands.rs`），绝不进本文件 / localStorage。
 * - `ACTIONS`：AI 浮层的动作预设。每个动作带 system + user prompt；选区文本
 *   由 Rust 侧拼接为 `\n\nText:\n<selection>`。
 */

/** 稳定 provider id（钥匙串槽位 key）。 */
export type ProviderId = "openai-compat" | "deepseek" | "ollama";

/** Rust 代理使用的线格式。 */
export type ApiFormat = "openai" | "ollama";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** OpenAI / Ollama 线格式。DeepSeek 与自定义端点共用 openai runner。 */
  apiFormat: ApiFormat;
  /** 默认模型名（留空则设置面板必填）。 */
  defaultModel: string;
  /** 默认端点；用户可覆盖。 */
  defaultBaseUrl?: string;
  /** 模型输入框下方的提示示例。 */
  modelHint?: string;
  /** 获取 API key 的入口链接。 */
  signupUrl?: string;
  /** 无账号后端（本地运行时）：key 可选，设置面板显示连接探测而非密钥验证。 */
  keyless?: boolean;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    // 任意 OpenAI Chat Completions 兼容端点：llama.cpp llama-server / LM Studio /
    // vLLM / Qwen / GLM / Kimi / 公司内部网关……地址自填、key 可选。
    id: "openai-compat",
    label: "OpenAI 兼容 (llama.cpp / LM Studio / vLLM / 自建)",
    apiFormat: "openai",
    defaultBaseUrl: "http://localhost:8080/v1",
    // 自建端点自己命名模型；默认留空，设置面板从 GET /models 填充。
    defaultModel: "",
    keyless: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiFormat: "openai",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    modelHint: "deepseek-chat · deepseek-reasoner",
    signupUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    apiFormat: "ollama",
    defaultModel: "qwen2.5:1.5b",
    defaultBaseUrl: "http://localhost:11434",
    modelHint: "qwen2.5 · llama3.2 · deepseek-r1 · gemma3",
    keyless: true,
  },
];

export function providerById(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// 动作表
// ---------------------------------------------------------------------------

export interface AIAction {
  /** 稳定 id（浮层切换 + 记忆最近动作）。 */
  id: string;
  /** i18n key（`ai.*` 命名空间）。 */
  labelKey: string;
  /** 系统提示词。 */
  system: string;
  /** 用户指令；选区由 Rust 拼接。 */
  user: string;
  /**
   * 结果去向：`replace` = 覆盖选区/全文（改写/精简/扩写）；
   * `save` = 输出另存为新 md 文件（原文件不动：翻译/总结/解释/自定义）。
   */
  resultMode: "replace" | "save";
  /** `save` 模式的文件名后缀（原文件名后追加，如 -总结）。 */
  saveSuffix?: string;
  /** 是否需要用户输入自定义指令。 */
  custom?: boolean;
}

const EDITOR_ROLE =
  "You are an expert editor. Always respond in the same language as the input text (e.g. Chinese input → Chinese output). Reply with only the rewritten text — no preamble, no explanations, no markdown fences.";

const TRANSLATOR_ROLE =
  "You are a professional translator. Detect the dominant language of the input text: if it is mainly Chinese, translate it into natural, idiomatic English; otherwise translate it into natural, fluent Chinese. Preserve the original markdown formatting, links, and code blocks. Reply with only the translation — no preamble.";

const EXPLAINER_ROLE =
  "You are a knowledgeable tutor. Always respond in the same language as the input text (e.g. Chinese input → Chinese output). Use plain prose; no markdown headings.";

export const ACTIONS: AIAction[] = [
  {
    id: "rewrite",
    labelKey: "ai.rewrite",
    system: EDITOR_ROLE,
    user: "改写下面的文字，提高清晰度与流畅度，保持原意与语气不变。只输出改写后的文本。",
    resultMode: "replace",
    saveSuffix: "-改写",
  },
  {
    id: "shorten",
    labelKey: "ai.shorten",
    system: EDITOR_ROLE,
    user: "把下面的文字改写得更简洁，保留全部关键信息。只输出改写后的文本。",
    resultMode: "replace",
    saveSuffix: "-精简",
  },
  {
    id: "expand",
    labelKey: "ai.expand",
    system: EDITOR_ROLE,
    user: "扩写下面的文字，补充细节与上下文，保持原有语气。只输出扩写后的文本。",
    resultMode: "replace",
    saveSuffix: "-扩写",
  },
  {
    id: "translate",
    labelKey: "ai.translate",
    system: TRANSLATOR_ROLE,
    user: "按系统指令检测语言并翻译下面的文字。只输出译文。",
    resultMode: "save",
    saveSuffix: "-翻译",
  },
  {
    id: "summarize",
    labelKey: "ai.summarize",
    system: EXPLAINER_ROLE,
    user: "用几句简洁的话总结下面的文字要点。只输出总结。",
    resultMode: "save",
    saveSuffix: "-总结",
  },
  {
    id: "explain",
    labelKey: "ai.explain",
    system: EXPLAINER_ROLE,
    user: "用通俗的语言向普通读者解释下面的文字。只输出解释。",
    resultMode: "save",
    saveSuffix: "-解释",
  },
  {
    id: "custom",
    labelKey: "ai.custom",
    system: EDITOR_ROLE,
    user: "",
    resultMode: "save",
    saveSuffix: "-自定义",
    custom: true,
  },
];

export function actionById(id: string): AIAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}
