// src/vim/config/configLoader.ts
// Vim 配置加载与持久化。独立 localStorage 键，绝不读写 zmd-shortcuts。

import type { VimConfig } from "../types";
export type { VimConfig };
import { buildDefaultConflictKeys } from "./conflictKeys";

/** Vim 配置的 localStorage 键（独立于 zmd-shortcuts） */
export const VIM_CONFIG_KEY = "zmd-vim-config";

/** 默认配置：默认关闭，零侵入；冲突键全部让渡给 Vim（与改动前行为一致） */
export const DEFAULT_VIM_CONFIG: VimConfig = {
  enabled: false,
  leaderKey: " ",
  menuTimeout: 3000,
  conflictKeys: buildDefaultConflictKeys(),
};

/** 从 localStorage 加载 Vim 配置，合并默认值（含 conflictKeys 逐键合并，新增的冲突键自动补默认值） */
export function loadVimConfig(): VimConfig {
  try {
    const saved = localStorage.getItem(VIM_CONFIG_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<VimConfig>;
      // 合并 conflictKeys：以默认值为基底，覆盖用户已保存的值
      const mergedConflictKeys = { ...buildDefaultConflictKeys(), ...(parsed.conflictKeys ?? {}) };
      return { ...DEFAULT_VIM_CONFIG, ...parsed, conflictKeys: mergedConflictKeys };
    }
  } catch {
    // 损坏的配置回退默认值
  }
  return { ...DEFAULT_VIM_CONFIG };
}

/** 保存 Vim 配置到 localStorage */
export function saveVimConfig(config: VimConfig): void {
  try {
    localStorage.setItem(VIM_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 忽略写入失败（隐私模式等）
  }
}
