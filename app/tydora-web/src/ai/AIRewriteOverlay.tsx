/**
 * AIRewriteOverlay —— AI 浮层（对照移植自 soloMD `AIRewriteOverlay.vue`，
 * 改写为 React）。
 *
 * 流程：
 *   1. 外部（更多菜单 / Ctrl+Shift+M）派发 `zmd-ai-open` 自定义事件，携带
 *      选区 `{ from, to, selection }` 与可选 `action`（菜单直达动作）。
 *   2. 用户选动作（或直达动作直接跑）→ invoke `ai_rewrite`（预铸 request_id）。
 *   3. 监听 `zmd-ai-chunk` / `zmd-ai-done` / `zmd-ai-error`（按 request_id 过滤），
 *      双栏实时渲染。
 *   4. 接受（Ctrl/Cmd+Enter）→ `replace` 动作派发 `zmd-ai-accept`（App 调
 *      `EditorHandle.replaceAt` 原位替换，单步可撤销）；`insert` 动作派发
 *      `zmd-ai-insert`（插入光标处）。拒绝（Esc）→ cancel。
 *
 * 配置每次打开浮层时重新读 localStorage（设置是独立窗口，props 会过期）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { ACTIONS, providerById, type AIAction } from "./providers";
import { loadAISettings, type AISettings } from "./aiSettings";
import "./AIRewriteOverlay.css";

/** 外部入口派发的事件：打开浮层。 */
export const AI_OPEN_EVENT = "zmd-ai-open";

export interface AIOpenDetail {
  /** 选区（编辑器统一偏移语义：IR=PM 位置，SV=源码偏移）；无选区时 selection 为空串。 */
  from: number;
  to: number;
  selection: string;
  /** 全文内容（打开时预捕获；浮层为模态，期间文档不变）。 */
  document: string;
  /** 强制处理范围；缺省 = 有选区用「选中文字」，否则「全文」。 */
  scope?: "selection" | "document";
  /** 原文件路径（另存为时用于定位目录与文件名）。 */
  sourcePath?: string | null;
}

/** 接受结果：替换选区（App → EditorHandle.replaceAt）。 */
export const AI_ACCEPT_EVENT = "zmd-ai-accept";
export interface AIAcceptDetail {
  from: number;
  to: number;
  replacement: string;
}

/** 接受结果：全文替换（App → EditorHandle.replaceAllContent）。 */
export const AI_ACCEPT_DOC_EVENT = "zmd-ai-accept-doc";
export interface AIAcceptDocDetail {
  replacement: string;
}

/** 接受结果：输出另存为新 md 文件（App 打开新文件）。 */
export const AI_SAVE_EVENT = "zmd-ai-save";
export interface AISaveDetail {
  path: string;
}

interface ChunkPayload { requestId: string; chunk: string; }
interface DonePayload { requestId: string; fullText: string; }
interface ErrorPayload { requestId: string; error: string; }

/** 浮层内使用的选区快照（来自 AIOpenDetail 的选区部分）。 */
interface AIRange {
  from: number;
  to: number;
  selection: string;
}

export function AIRewriteOverlay() {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<AIRange | null>(null);
  /** 处理范围：selection=选中的文字（默认）；document=全文。 */
  const [scope, setScope] = useState<"selection" | "document">("selection");
  /** 打开时预捕获的全文（模态期间文档不变）。 */
  const [docText, setDocText] = useState("");
  /** 原文件路径（另存为定位目录/文件名；无保存过的文件为 null）。 */
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  /** 另存为写入中。 */
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<AIAction | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [proposed, setProposed] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingError, setStreamingError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const proposedRef = useRef<HTMLDivElement | null>(null);

  // 每次打开时重读（设置是独立窗口，localStorage 可能已变）
  const [liveHasKey, setLiveHasKey] = useState(false);
  const [cfg, setCfg] = useState<AISettings>(() => loadAISettings());

  useEffect(() => {
    if (!open) return;
    setCfg(loadAISettings());
    void invoke<boolean>("ai_has_key", { provider: loadAISettings().provider })
      .then((k) => setLiveHasKey(k))
      .catch(() => setLiveHasKey(false));
  }, [open]);

  const providerLabel = providerById(cfg.provider)?.label ?? cfg.provider;
  const needsKey = !providerById(cfg.provider)?.keyless && !liveHasKey;

  const reset = useCallback(() => {
    setProposed("");
    setStreamingError(null);
  }, []);

  const close = useCallback(() => {
    // best-effort 取消在途流
    const id = requestIdRef.current;
    if (id) void invoke("ai_cancel", { requestId: id }).catch(() => undefined);
    requestIdRef.current = null;
    setOpen(false);
    setRange(null);
    setDocText("");
    setSourcePath(null);
    setSaving(false);
    setScope("selection");
    setAction(null);
    setCustomPrompt("");
    setStreaming(false);
    reset();
  }, [reset]);

  // ── 事件监听：打开 ─────────────────────────────────────────────
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<AIOpenDetail>).detail;
      if (!detail || !detail.document) return;
      const s = loadAISettings();
      if (!s.enabled) return;
      const hasSel = !!detail.selection;
      setRange(hasSel ? { from: detail.from, to: detail.to, selection: detail.selection } : null);
      setDocText(detail.document);
      setSourcePath(detail.sourcePath ?? null);
      // 范围：外部强制 > 有选区默认「选中文字」 > 无选区「全文」（顶部提醒先选文字）
      setScope(hasSel ? (detail.scope === "document" ? "document" : "selection") : "document");
      setCustomPrompt("");
      reset();
      setOpen(true);
      // 权威 key 检查（props/localStorage 都可能过期）
      void invoke<boolean>("ai_has_key", { provider: s.provider })
        .then((k) => setLiveHasKey(k))
        .catch(() => setLiveHasKey(false));
      setAction(null);
    };
    window.addEventListener(AI_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(AI_OPEN_EVENT, onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 事件监听：流 ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let unChunk: UnlistenFn | null = null;
    let unDone: UnlistenFn | null = null;
    let unErr: UnlistenFn | null = null;
    let disposed = false;

    void (async () => {
      unChunk = await listen<ChunkPayload>("zmd-ai-chunk", (e) => {
        if (!requestIdRef.current || e.payload.requestId !== requestIdRef.current) return;
        setProposed((p) => p + e.payload.chunk);
        const el = proposedRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      unDone = await listen<DonePayload>("zmd-ai-done", (e) => {
        if (!requestIdRef.current || e.payload.requestId !== requestIdRef.current) return;
        // 后端全文为准（>= 本地累计时替换，防丢块）
        setProposed((p) =>
          e.payload.fullText && e.payload.fullText.length >= p.length ? e.payload.fullText : p,
        );
        setStreaming(false);
        requestIdRef.current = null;
      });
      unErr = await listen<ErrorPayload>("zmd-ai-error", (e) => {
        if (!requestIdRef.current || e.payload.requestId !== requestIdRef.current) return;
        if (e.payload.error !== "cancelled") setStreamingError(e.payload.error);
        setStreaming(false);
        requestIdRef.current = null;
      });
      if (disposed) {
        unChunk?.();
        unDone?.();
        unErr?.();
      }
    })();

    return () => {
      disposed = true;
      unChunk?.();
      unDone?.();
      unErr?.();
    };
  }, [open]);

  // ── 键盘：Esc 拒绝 / Ctrl+Enter 接受 ───────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        if (proposed && !streaming && !streamingError) {
          ev.preventDefault();
          if (action?.resultMode === "save") void onSaveAs();
          else onAccept();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, proposed, streaming, streamingError, close]);

  // ── 启动动作 ───────────────────────────────────────────────────
  async function startAction(
    a: AIAction,
    s = loadAISettings(),
    r: AIRange | null = range,
    effScope: "selection" | "document" = scope,
  ): Promise<void> {
    // 实际处理文本：全文 = 打开时预捕获的整篇；选区 = 打开时捕获的选区
    const text = effScope === "document" ? docText : (r?.selection ?? "");
    if (!text) return;
    setAction(a);
    reset();
    setStreaming(true);
    // 预铸 request_id，监听器先于 invoke 就绪（soloMD 竞态教训）
    const newRequestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestIdRef.current = newRequestId;
    try {
      const pcfg = providerById(s.provider);
      const userPrompt = a.custom ? customPrompt.trim() : a.user;
      await invoke<string>("ai_rewrite", {
        request: {
          provider: s.provider,
          apiFormat: pcfg?.apiFormat ?? "openai",
          model: s.models[s.provider] || pcfg?.defaultModel || "",
          system: a.system,
          user: userPrompt,
          selection: text,
          baseUrl: s.baseUrls[s.provider] || pcfg?.defaultBaseUrl || null,
          requestId: newRequestId,
        },
      });
    } catch (err) {
      setStreaming(false);
      requestIdRef.current = null;
      setStreamingError(String(err));
    }
  }

  async function onReroll(): Promise<void> {
    if (!action) return;
    const id = requestIdRef.current;
    if (id) await invoke("ai_cancel", { requestId: id }).catch(() => undefined);
    requestIdRef.current = null;
    void startAction(action);
  }

  function onAccept(): void {
    if (!action || !proposed) return;
    if (action.resultMode === "save") {
      // 翻译/总结/解释/自定义：输出另存为新 md 文件（原文件不动）
      void onSaveAs();
      return;
    }
    if (scope === "document") {
      // 全文：整篇替换（EditorHandle.replaceAllContent，单步可撤销）
      window.dispatchEvent(
        new CustomEvent<AIAcceptDocDetail>(AI_ACCEPT_DOC_EVENT, { detail: { replacement: proposed } }),
      );
    } else {
      if (!range) return;
      window.dispatchEvent(
        new CustomEvent<AIAcceptDetail>(AI_ACCEPT_EVENT, {
          detail: { from: range.from, to: range.to, replacement: proposed },
        }),
      );
    }
    close();
  }

  /** save 模式：输出写入原文件目录下的「原文件名-后缀.md」，成功后打开新文件。 */
  async function onSaveAs(): Promise<void> {
    if (!proposed) return;
    const suffix = action?.saveSuffix ?? "-AI";
    if (!sourcePath) {
      setStreamingError(t("ai.noSourceFile"));
      return;
    }
    const sep = Math.max(sourcePath.lastIndexOf("\\"), sourcePath.lastIndexOf("/"));
    const dir = sep > 0 ? sourcePath.slice(0, sep) : "";
    const base = sourcePath.slice(sep + 1).replace(/\.[^.]+$/, "");
    const newPath = `${dir}/${base}${suffix}.md`;
    setSaving(true);
    try {
      await writeTextFile(newPath, proposed);
      window.dispatchEvent(
        new CustomEvent<AISaveDetail>(AI_SAVE_EVENT, { detail: { path: newPath } }),
      );
      close();
    } catch (err) {
      // 不关闭浮层：错误就地显示在错误区
      setStreamingError(String(err));
    } finally {
      setSaving(false);
    }
  }

  function openSettingsAI(): void {
    close();
    localStorage.setItem("zmd-settings-initial-tab", "ai");
    window.dispatchEvent(new CustomEvent("zmd-open-settings"));
  }

  // ── 渲染 ───────────────────────────────────────────────────────
  if (!open) return null;

  const showPicker = !action || (action.custom && !proposed && !streaming);

  return (
    <div className="ai-overlay__backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="ai-overlay" role="dialog" aria-label={t("ai.title")}>
        <header className="ai-overlay__head">
          <span className="ai-overlay__title">{t("ai.title")}</span>
          <span className="ai-overlay__provider">{providerLabel}</span>
          <button className="ai-overlay__close" onClick={close} aria-label="Close">×</button>
        </header>

        {/* 处理范围：默认「选中文字」；无选区时提醒先选文字，「全文」始终可用 */}
        <div className="ai-overlay__scope">
          <span className="ai-overlay__scope-label">{t("ai.scope")}</span>
          <div className="ai-overlay__scope-switch">
            <button
              className={scope === "selection" ? "active" : ""}
              disabled={!range || !!action || streaming}
              onClick={() => setScope("selection")}
            >
              {t("ai.scopeSelection")}
            </button>
            <button
              className={scope === "document" ? "active" : ""}
              disabled={!docText || !!action || streaming}
              onClick={() => setScope("document")}
            >
              {t("ai.scopeDocument")}
            </button>
          </div>
          <span className={`ai-overlay__scope-hint${!range ? " warn" : ""}`}>
            {!range
              ? t("ai.scopeNoSelection")
              : scope === "document"
                ? t("ai.scopeDocumentHint", { count: docText.length })
                : t("ai.scopeSelectionHint", { count: range.selection.length })}
          </span>
        </div>

        {needsKey ? (
          <div className="ai-overlay__nokey">
            <p>{t("ai.noKey", { provider: providerLabel })}</p>
            <button className="ai-overlay__btn ai-overlay__btn--primary" onClick={openSettingsAI}>
              {t("ai.setKey")}
            </button>
          </div>
        ) : showPicker ? (
          <div className="ai-overlay__picker">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                className={`ai-overlay__action${action?.id === a.id ? " active" : ""}`}
                onClick={() => {
                  if (a.custom) {
                    setAction(a);
                  } else {
                    void startAction(a);
                  }
                }}
              >
                {t(a.labelKey)}
              </button>
            ))}
            {action?.custom && (
              <div className="ai-overlay__custom">
                <label className="ai-overlay__label">{t("ai.customPrompt")}</label>
                <textarea
                  className="ai-overlay__textarea"
                  rows={3}
                  value={customPrompt}
                  placeholder={t("ai.customPrompt")}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    // ⌘/Ctrl+Enter 直接提交（与浮层其他按钮的 ⌘↵ 习惯一致）
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      if (action) void startAction(action);
                    }
                  }}
                />
                <button
                  className="ai-overlay__btn ai-overlay__btn--primary"
                  disabled={!customPrompt.trim()}
                  onClick={() => action && void startAction(action)}
                >
                  {t("ai.run")}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="ai-overlay__diff">
            <div className="ai-overlay__banner-row">
              {streaming && !streamingError ? (
                <div className="ai-overlay__banner live">
                  <span className="ai-overlay__spinner" aria-hidden="true" />
                  <span>{t("ai.sending", { provider: providerLabel })}</span>
                </div>
              ) : !streaming && !streamingError && proposed ? (
                <div className="ai-overlay__banner done">✓ {t("ai.proposed")}</div>
              ) : null}
              {streamingError && <div className="ai-overlay__error">{streamingError}</div>}
            </div>
            <div className="ai-overlay__columns">
              <div className="ai-overlay__col">
                <div className="ai-overlay__col-head">{t("ai.original")}</div>
                <div
                  className={`ai-overlay__col-body${action?.resultMode === "replace" ? " orig" : ""}`}
                >
                  {scope === "document" ? docText : range?.selection}
                </div>
              </div>
              <div className="ai-overlay__col">
                <div className="ai-overlay__col-head">{t("ai.proposed")}</div>
                <div ref={proposedRef} className="ai-overlay__col-body prop">
                  {proposed || (streaming ? <span className="ai-overlay__placeholder">{t("ai.empty")}</span> : null)}
                  {streaming && <span className="ai-overlay__cursor">▌</span>}
                </div>
              </div>
            </div>
            <div className="ai-overlay__buttons">
              <button className="ai-overlay__btn" onClick={close}>
                {t("ai.reject")} <span className="ai-overlay__kbd">Esc</span>
              </button>
              <button className="ai-overlay__btn" disabled={streaming} onClick={() => void onReroll()}>
                {t("ai.reroll")}
              </button>
              <button
                className="ai-overlay__btn ai-overlay__btn--primary"
                disabled={streaming || saving || !proposed || !!streamingError}
                onClick={() => (action?.resultMode === "save" ? void onSaveAs() : onAccept())}
              >
                {action?.resultMode === "save" ? t("ai.saveAs") : t("ai.accept")}
                <span className="ai-overlay__kbd">⌘↵</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
