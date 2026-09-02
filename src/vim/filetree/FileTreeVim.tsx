// src/vim/filetree/FileTreeVim.tsx
// 文件树 neo-tree 风格快捷键 HOC。
//
// 架构：本文件只负责激活判定 + 键盘 → vim-sidebar-action CustomEvent 的翻译；
// 真正的状态修改（光标跳跃、目录展开、文件新建/重命名/删除/复制等）全部在
// Sidebar/FileTree 组件内部通过监听 vim-sidebar-action 完成，保证 j/k 高亮
// 永远**不触发 onSelect**（只有 confirm-open / l/Enter/o 才真正打开文件）。

import { useEffect, useRef, type ComponentType } from "react";
import { useVim } from "../VimProvider";

type Detail = { action: string; path?: string; delta?: number };
function act(action: string, extra?: Partial<Detail>) {
  window.dispatchEvent(new CustomEvent<Detail>("vim-sidebar-action", {
    detail: { action, ...extra },
  }));
}

export function FileTreeVim<P extends object>(Wrapped: ComponentType<P>): ComponentType<P> {
  return function VimFileTreeWrapper(props: P) {
    const { enabled } = useVim();
    const treeActiveRef = useRef(false);
    const gPendingRef = useRef(false);

    useEffect(() => {
      if (!enabled) return;

      const activate = () => { treeActiveRef.current = true; };

      const handleClick = (e: MouseEvent) => {
        const tree = document.querySelector(".sidebar-tree");
        const sidebar = document.querySelector(".sidebar");
        const target = e.target as Node;
        if ((tree && tree.contains(target)) || (sidebar && sidebar.contains(target))) {
          activate();
          // 真实点击某个 tree-node → 把 Vim 光标对齐到该节点（之后 j/k 从这里起步）
          const tn = (target as HTMLElement)?.closest?.<HTMLElement>(".tree-node[data-path]");
          if (tn?.dataset.path) act("highlight-path", { path: tn.dataset.path });
        } else {
          treeActiveRef.current = false;
        }
      };

      const handleFocus = (e: FocusEvent) => {
        const tree = document.querySelector(".sidebar-tree");
        const sidebar = document.querySelector(".sidebar");
        const el = e.target as Node | null;
        if (!el) return;
        if ((tree && tree.contains(el)) || (sidebar && sidebar.contains(el))) activate();
      };

      document.addEventListener("click", handleClick, true);
      document.addEventListener("focusin", handleFocus, true);

      const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        // 上下文菜单或弹窗已开时：不拦截
        if (document.querySelector(".context-menu, .modal, [role='dialog']")) return;

        const tree = document.querySelector<HTMLElement>(".sidebar-tree");
        if (!tree) return;

        const sidebarEl = document.querySelector(".sidebar") as HTMLElement | null;
        const activated = treeActiveRef.current
          || (sidebarEl && (sidebarEl.contains(document.activeElement) || sidebarEl === document.activeElement));
        if (!activated) return;

        // 焦点仍在编辑器中：不拦截（即使侧栏刚被 click 激活，只要用户又点回编辑器就应该让编辑器 Vim 接手）
        const editorHost =
          document.querySelector(".ProseMirror") as HTMLElement | null
          ?? document.querySelector(".codemirror-editor") as HTMLElement | null;
        if (editorHost && editorHost.contains(document.activeElement)) return;

        const key = e.key;
        const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;

        let handled = true;
        if (noMods) {
          switch (key) {
            // 导航：只 highlight，不打开
            case "j":
            case "ArrowDown":
              act("highlight-next");
              break;
            case "k":
            case "ArrowUp":
              act("highlight-prev");
              break;
            case "Home":
              act("highlight-first");
              break;
            case "End":
              act("highlight-last");
              break;
            case "H":
              act("highlight-first");
              break;
            case "G":
              act("highlight-last");
              break;
            case "g":
              gPendingRef.current = true;
              window.setTimeout(() => { gPendingRef.current = false; }, 450);
              handled = false; // 单独的 g 不做 preventDefault，让浏览器默认过
              break;

            case "h":
            case "Backspace":
              // 已展开目录 → 折叠；文件 / 未展开目录 → 高亮父目录
              act("h-toggle");
              break;
            case "p":
              act("highlight-parent");
              break;

            // 目录结构
            case "W":
              act("collapse-all");
              break;
            case "E":
              act("expand-all");
              break;
            case "C":
              act("collapse-branch");
              break;

            // 真正打开 / 展开
            case "l":
            case "Enter":
            case "o":
              act("confirm-open");
              break;

            // 分屏打开：\ 水平分屏(lr)，- 垂直分屏(tb) —— 等价于先分屏再在新窗格中打开选中文件
            case "\\":
            case "-": {
              const p = document
                .querySelector<HTMLElement>(".tree-node.pending-active[data-path]")
                ?.dataset.path;
              if (p) {
                window.dispatchEvent(new CustomEvent("vim-sidebar-action", {
                  detail: {
                    action: key === "\\" ? "open-split-lr" : "open-split-tb",
                    path: p,
                  },
                }));
                treeActiveRef.current = false;
              }
              break;
            }

            // 文件操作：直接走 Sidebar 内部同逻辑（避免依赖右键菜单 DOM 查找）
            case "a":
            case "%":
              act("new-file");
              break;
            case "A":
              act("new-folder");
              break;
            case "r":
              act("rename");
              break;
            case "d":
              act("delete");
              break;
            case "D":
            case "c":
              act("duplicate");
              break;
            case "x":
              act("move-to");
              break;
            case "y":
              act("copy-path");
              break;

            case "R":
              // App 级 refresh：让 treeRefreshKey++ 重新 loadRoot
              window.dispatchEvent(new CustomEvent("vim-sidebar-action", {
                detail: { action: "refresh" },
              }));
              break;

            case "q":
              treeActiveRef.current = false;
              // 通过 App 的窗格系统聚焦激活编辑器（兼容多窗格，避免 raw DOM focus 找错窗格）
              window.dispatchEvent(new CustomEvent("vim-app-action", {
                detail: { action: "focus-editor" },
              }));
              break;

            default:
              handled = false;
              break;
          }
        }

        // gg → 首项（g-pending 窗口内再按一次 g）
        if (!handled && noMods && key === "g" && gPendingRef.current) {
          gPendingRef.current = false;
          act("highlight-first");
          handled = true;
        }

        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      };

      window.addEventListener("keydown", handleKeyDown, true);
      return () => {
        document.removeEventListener("click", handleClick, true);
        document.removeEventListener("focusin", handleFocus, true);
        window.removeEventListener("keydown", handleKeyDown, true);
      };
    }, [enabled]);

    return <Wrapped {...props} />;
  };
}
