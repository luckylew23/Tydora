/**
 * 右侧边栏「AI」页签——BrainyAI 式多模型群聊面板。
 *
 * 布局（窄栏适配）：顶行（会话抽屉 + 标题 + 新建）→ 模型勾选条 → 消息流
 * （每轮：用户气泡 + 各模型回答 tab 切换）→ 引用文档开关 + 输入框。
 * 状态全部在 chatStore（模块级单例）：切页签/折叠侧栏流式与历史不丢。
 */

import { useSyncExternalStore, useState, useRef, useEffect } from "react";
import MarkdownIt from "markdown-it";
import * as store from "./chatStore";
import "./SidebarChat.css";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const PROVIDER_LABELS: Record<string, string> = {
  "openai-compat": "OpenAI 兼容",
  deepseek: "DeepSeek",
  ollama: "Ollama",
};

interface Props {
  /** 当前文档内容（「引用当前文档」阅读模式上下文）。 */
  docContent: string;
  docName: string | null;
}

export function SidebarChatPanel({ docContent, docName }: Props) {
  useSyncExternalStore(store.subscribeChat, store.getChatVersion);
  const session = store.getActiveSession();
  const models = store.getModels();

  const [input, setInput] = useState("");
  const [docRefOn, setDocRefOn] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showModelMgr, setShowModelMgr] = useState(false);
  // 每轮当前选中的模型 tab
  const [activeModelByTurn, setActiveModelByTurn] = useState<Record<string, string>>({});
  // 模型管理表单
  const [newProvider, setNewProvider] = useState<string>("openai-compat");
  const [newModel, setNewModel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void store.registerStreamListeners();
  }, []);

  const inflight = store.isInflight();
  const answersOf = (turnId: string) => session?.turns.find((t) => t.id === turnId)?.answers ?? [];

  function send(): void {
    const q = input.trim();
    if (!q || inflight) return;
    const sid = session?.id ?? store.createSession([]).id;
    store.sendGroupTurn(
      sid,
      q,
      docRefOn && docContent ? docContent : undefined,
      docRefOn ? docName ?? undefined : undefined,
    );
    setInput("");
  }

  function addModel(): void {
    const model = newModel.trim();
    if (!model) return;
    const entry = store.addModel({
      provider: newProvider as "openai-compat" | "deepseek" | "ollama",
      model,
      baseUrl: newBaseUrl.trim() || undefined,
    });
    setNewModel("");
    setNewBaseUrl("");
    // 新模型自动加入当前会话勾选
    if (session) store.setSessionModels(session.id, [...session.modelIds, entry.id]);
  }

  const canSend = !!input.trim() && !inflight && session !== null;
  const needsModel = models.length === 0;

  return (
    <div className="sidebar-chat">
      {/* 顶行 */}
      <div className="sidebar-chat__top">
        <button
          className="sidebar-chat__icon-btn"
          title="会话列表"
          onClick={() => setShowSessions((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" />
          </svg>
        </button>
        <span className="sidebar-chat__title" title={session?.title}>
          {session?.title ?? "AI 对话"}
        </span>
        <button
          className="sidebar-chat__icon-btn"
          title="新建对话"
          onClick={() => store.createSession(session?.modelIds ?? [])}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* 会话列表抽屉 */}
      {showSessions && (
        <div className="sidebar-chat__sessions">
          {store.getSessions().map((s) => (
            <div
              key={s.id}
              className={`sidebar-chat__session-item${session?.id === s.id ? " active" : ""}`}
              onClick={() => {
                store.setActiveSession(s.id);
                setShowSessions(false);
              }}
            >
              <span className="sidebar-chat__session-title">{s.title}</span>
              <button
                className="sidebar-chat__session-del"
                title="删除会话"
                onClick={(e) => {
                  e.stopPropagation();
                  store.deleteSession(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {store.getSessions().length === 0 && (
            <div className="sidebar-chat__session-empty">暂无会话</div>
          )}
        </div>
      )}

      {/* 模型管理 */}
      <div className="sidebar-chat__models">
        <div className="sidebar-chat__models-head">
          <span
            className="sidebar-chat__models-toggle"
            onClick={() => setShowModelMgr((v) => !v)}
          >
            模型 {models.length > 0 ? `(${models.length})` : ""}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points={showModelMgr ? "18 15 12 9 6 15" : "6 9 12 15"} />
            </svg>
          </span>
        </div>
        {showModelMgr && (
          <div className="sidebar-chat__model-mgr">
            {models.map((m) => (
              <div key={m.id} className="sidebar-chat__model-item">
                <span className="sidebar-chat__model-name">
                  <b>{PROVIDER_LABELS[m.provider] ?? m.provider}</b> · {m.model}
                  {m.baseUrl ? ` · ${m.baseUrl}` : ""}
                </span>
                <button
                  className="sidebar-chat__model-del"
                  title="删除模型"
                  onClick={() => store.removeModel(m.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="sidebar-chat__model-add">
              <select
                className="sidebar-chat__input"
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
              >
                <option value="openai-compat">OpenAI 兼容</option>
                <option value="deepseek">DeepSeek</option>
                <option value="ollama">Ollama</option>
              </select>
              <input
                className="sidebar-chat__input"
                placeholder="模型名，如 deepseek-chat"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
              />
              <input
                className="sidebar-chat__input"
                placeholder="Base URL（可选）"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
              />
              <button className="sidebar-chat__btn" disabled={!newModel.trim()} onClick={addModel}>
                添加模型
              </button>
            </div>
            <div className="sidebar-chat__model-hint">
              密钥在各 provider 的钥匙串槽位（设置 → 功能 → AI 保存）
            </div>
          </div>
        )}
        {/* 参与勾选 chips */}
        {models.length > 0 && (
          <div className="sidebar-chat__chips">
            {models.map((m) => {
              const checked = session?.modelIds.includes(m.id) ?? false;
              return (
                <button
                  key={m.id}
                  className={`sidebar-chat__chip${checked ? " checked" : ""}`}
                  title={`${PROVIDER_LABELS[m.provider] ?? m.provider} · ${m.model}`}
                  onClick={() => {
                    if (!session) return;
                    const next = checked
                      ? session.modelIds.filter((id) => id !== m.id)
                      : [...session.modelIds, m.id];
                    store.setSessionModels(session.id, next);
                  }}
                >
                  {m.model}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 消息流 */}
      <div className="sidebar-chat__flow">
        {needsModel ? (
          <div className="sidebar-chat__empty">
            先在上方「模型管理」添加至少一个模型（如 deepseek-chat 或 Ollama 本地模型）。
          </div>
        ) : !session || session.turns.length === 0 ? (
          <div className="sidebar-chat__empty">
            输入问题，同时发给勾选的多个模型对比回答。
            {docName && docContent ? " 可开启「引用当前文档」让 AI 阅读本篇笔记。" : ""}
          </div>
        ) : (
          session.turns.map((turn) => {
            const answers = answersOf(turn.id);
            const activeModel =
              activeModelByTurn[turn.id] && answers.some((a) => a.modelId === activeModelByTurn[turn.id])
                ? activeModelByTurn[turn.id]
                : (answers[0]?.modelId ?? "");
            const active = answers.find((a) => a.modelId === activeModel);
            return (
              <div key={turn.id} className="sidebar-chat__turn">
                <div className="sidebar-chat__q">{turn.question}</div>
                {answers.length > 1 && (
                  <div className="sidebar-chat__answer-tabs">
                    {answers.map((a) => {
                      const m = store.getModelById(a.modelId);
                      return (
                        <button
                          key={a.modelId}
                          className={`sidebar-chat__answer-tab${a.modelId === activeModel ? " active" : ""}${a.error ? " err" : ""}`}
                          onClick={() =>
                            setActiveModelByTurn((prev) => ({ ...prev, [turn.id]: a.modelId }))
                          }
                        >
                          {m?.model ?? a.modelId}
                          {!a.done && " …"}
                        </button>
                      );
                    })}
                  </div>
                )}
                {active && active.error ? (
                  <div className="sidebar-chat__error">{active.error}</div>
                ) : active ? (
                  <div
                    className={`sidebar-chat__a${active.done ? "" : " streaming"}`}
                    dangerouslySetInnerHTML={{ __html: md.render(active.content) }}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* 引用文档 + 输入 */}
      <div className="sidebar-chat__inputbar">
        {docName && docContent ? (
          <button
            className={`sidebar-chat__doc-ref${docRefOn ? " on" : ""}`}
            title={docRefOn ? "已引用当前文档：发送时作为上下文" : "引用当前文档作为上下文"}
            onClick={() => setDocRefOn((v) => !v)}
          >
            {docRefOn ? "✓ " : ""}引用《{docName.length > 12 ? docName.slice(0, 12) + "…" : docName}》
          </button>
        ) : null}
        <textarea
          ref={inputRef}
          className="sidebar-chat__input"
          rows={2}
          placeholder={inflight ? "生成中…（可点停止）" : "问点什么…（Enter 发送）"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) send();
            }
          }}
        />
        <div className="sidebar-chat__input-actions">
          {inflight ? (
            <button className="sidebar-chat__btn" onClick={() => store.stopStreaming()}>
              停止
            </button>
          ) : (
            <button className="sidebar-chat__btn primary" disabled={!canSend} onClick={send}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
