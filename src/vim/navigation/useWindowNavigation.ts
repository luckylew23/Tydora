// src/vim/navigation/useWindowNavigation.ts
// Vim 风格窗口导航。
//
// Ctrl+h/j/k/l（大小写不敏感）→ 焦点切换（左/下/上/右）
// 移动窗格位置（move-pane）由 Leader 菜单 H/J/K/L 提供（leader.ts）
//
// 所有动作通过 vim-app-action 事件分发到 App.tsx 统一处理。

import { useEffect, useRef } from "react";
import { useVim } from "../VimProvider";

export function useWindowNavigation(): void {
  const { enabled } = useVim();
  // 用 ref 运行时判断 enabled，effect 永久挂载，避免 enabled 状态变化导致监听未及时注册
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // 仅拦截 Ctrl+h/j/k/l 和 Ctrl+H/J/K/L（无 Alt/Meta）
      if (!e.ctrlKey || e.altKey || e.metaKey) return;

      const dirMap: Record<string, "left" | "down" | "up" | "right"> = {
        h: "left", j: "down", k: "up", l: "right",
        H: "left", J: "down", K: "up", L: "right",
      };
      const dir = dirMap[e.key];
      if (!dir) return;

      // 不拦截原生输入框（搜索框、QuickOpen、终端 textarea）中的 Ctrl+h/j/k/l
      // 编辑器（ProseMirror / CodeMirror 的 contentEditable）不在此列 → 允许 Ctrl+hjkl 切面板
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      // ── 诊断日志：定位 Ctrl+hjkl 是否触发（确认后删除）──
      console.log("[vim-nav] Ctrl+" + e.key, { dir, targetTag: target.tagName, targetClass: (target.className || "").slice(0, 40) });

      e.preventDefault();
      e.stopPropagation();

      // 大小写统一做焦点切换（贴合 LazyVim <C-h>/<C-l> 语义）
      window.dispatchEvent(new CustomEvent("vim-app-action", { detail: { action: `app.focus-${dir}` } }));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}
