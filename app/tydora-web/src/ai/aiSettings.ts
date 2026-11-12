/**
 * AI 设置持久化（`zmd-ai-settings`，localStorage）。
 *
 * 只存非敏感配置（provider/model/baseUrl/开关）。API key 永远在 OS 钥匙串
 * （Rust `ai_set_key` 等），绝不写入 localStorage。
 *
 * 设置是独立窗口（`?window=settings`），主窗口收不到 React 状态更新 ——
 * 使用方应在每次打开浮层时重新 `loadAISettings()`，不要缓存旧值。
 */

import type { ProviderId } from "./providers";

export interface AISettings {
  /** 总开关；默认关。 */
  enabled: boolean;
  provider: ProviderId;
  /** 每家各自的模型记忆（切换 provider 不丢）。 */
  models: Partial<Record<ProviderId, string>>;
  /** 每家各自的 base URL 覆盖。 */
  baseUrls: Partial<Record<ProviderId, string>>;
}

const KEY = "zmd-ai-settings";

const DEFAULTS: AISettings = {
  enabled: false,
  provider: "openai-compat",
  models: {},
  baseUrls: {},
};

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AISettings>;
    const merged: AISettings = {
      ...DEFAULTS,
      ...parsed,
      models: { ...DEFAULTS.models, ...(parsed.models ?? {}) },
      baseUrls: { ...DEFAULTS.baseUrls, ...(parsed.baseUrls ?? {}) },
    };
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAISettings(s: AISettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // localStorage 不可用时忽略
  }
}
