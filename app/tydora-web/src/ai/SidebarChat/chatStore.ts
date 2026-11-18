/**
 * 右侧边栏 AI 群聊的状态存储（模块级单例）。
 *
 * 为什么不用组件 state：流式回答持续数秒到数分钟，用户切走侧栏页签/折叠
 * 侧栏时组件会卸载——模块级 store 让流式与历史跨组件生命周期存活，切回来
 * 内容都在。事件监听（zmd-ai-chunk/done/error）也挂在模块级，组件卸载不中断。
 *
 * 持久化：localStorage `zmd-ai-chats`（会话）与 `zmd-ai-chat-models`（模型条目）。
 * 流式进行中的增量不落盘（太频繁），轮次完成（done/error）时持久化。
 */

import { invoke } from "@tauri-apps/api/core";

// ── 数据模型 ──────────────────────────────────────────────────────

export interface ChatModelEntry {
  /** 稳定 id（勾选/路由用）。 */
  id: string;
  /** provider id：openai-compat / deepseek / ollama。 */
  provider: "openai-compat" | "deepseek" | "ollama";
  /** 模型名。 */
  model: string;
  /** base URL 覆盖（可选）。 */
  baseUrl?: string;
}

export interface ChatAnswer {
  modelId: string;
  content: string;
  done: boolean;
  error?: string;
}

export interface ChatTurn {
  id: string;
  question: string;
  /** 引用当前文档时的文档名（展示用）。 */
  docName?: string;
  answers: ChatAnswer[];
  ts: number;
}

export interface ChatSession {
  id: string;
  title: string;
  /** 参与模型 id 列表（按勾选顺序）。 */
  modelIds: string[];
  turns: ChatTurn[];
  createdAt: number;
}

// ── 模块级状态 ────────────────────────────────────────────────────

const SESSIONS_KEY = "zmd-ai-chats";
const MODELS_KEY = "zmd-ai-chat-models";
const ACTIVE_KEY = "zmd-ai-chats-active";

const DEFAULT_MODELS: ChatModelEntry[] = [
  { id: "deepseek-default", provider: "deepseek", model: "deepseek-chat" },
];

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let sessions: ChatSession[] = loadJson<ChatSession[]>(SESSIONS_KEY, []);
let models: ChatModelEntry[] = loadJson<ChatModelEntry[]>(MODELS_KEY, DEFAULT_MODELS);
let activeSessionId: string | null = loadJson<string | null>(ACTIVE_KEY, null);

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeSessionId));
  } catch {
    // localStorage 不可用时忽略（流式仍在内存中）
  }
  listeners.forEach((l) => l());
}

export function subscribeChat(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getChatVersion(): number {
  return version;
}

// ── 访问器 ────────────────────────────────────────────────────────

export function getSessions(): ChatSession[] {
  return sessions;
}

export function getActiveSession(): ChatSession | null {
  return sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
}

export function getModels(): ChatModelEntry[] {
  return models;
}

export function getModelById(id: string): ChatModelEntry | undefined {
  return models.find((m) => m.id === id);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── 会话操作 ──────────────────────────────────────────────────────

export function setActiveSession(id: string): void {
  activeSessionId = id;
  emit();
}

export function createSession(modelIds: string[]): ChatSession {
  const s: ChatSession = {
    id: newId(),
    title: "新对话",
    modelIds: modelIds.length ? modelIds : models.slice(0, 1).map((m) => m.id),
    turns: [],
    createdAt: Date.now(),
  };
  sessions = [s, ...sessions];
  activeSessionId = s.id;
  emit();
  return s;
}

export function deleteSession(id: string): void {
  sessions = sessions.filter((s) => s.id !== id);
  if (activeSessionId === id) activeSessionId = sessions[0]?.id ?? null;
  emit();
}

export function renameSession(id: string, title: string): void {
  sessions = sessions.map((s) => (s.id === id ? { ...s, title } : s));
  emit();
}

export function setSessionModels(id: string, modelIds: string[]): void {
  sessions = sessions.map((s) => (s.id === id ? { ...s, modelIds } : s));
  emit();
}

// ── 模型条目操作 ──────────────────────────────────────────────────

export function addModel(entry: Omit<ChatModelEntry, "id">): ChatModelEntry {
  const m: ChatModelEntry = { ...entry, id: newId() };
  models = [...models, m];
  emit();
  return m;
}

export function removeModel(id: string): void {
  models = models.filter((m) => m.id !== id);
  // 从所有会话的勾选中同步移除
  sessions = sessions.map((s) => ({ ...s, modelIds: s.modelIds.filter((mid) => mid !== id) }));
  emit();
}

// ── 流式发送（BrainyAI 群聊语义：一轮问题 → 每模型独立回答） ─────────

/** 进行中的请求 requestId → {turnId, modelId}（用于停止按钮）。 */
const inflight = new Map<string, { sessionId: string; turnId: string; modelId: string }>();

export function isInflight(): boolean {
  return inflight.size > 0;
}

/** 停止当前会话所有在途请求。 */
export function stopStreaming(): void {
  for (const requestId of [...inflight.keys()]) {
    void invoke("ai_cancel", { requestId }).catch(() => undefined);
  }
}

function updateAnswer(
  sessionId: string,
  turnId: string,
  modelId: string,
  patch: Partial<ChatAnswer>,
): void {
  sessions = sessions.map((s) => {
    if (s.id !== sessionId) return s;
    return {
      ...s,
      turns: s.turns.map((t) => {
        if (t.id !== turnId) return t;
        return {
          ...t,
          answers: t.answers.map((a) => (a.modelId === modelId ? { ...a, ...patch } : a)),
        };
      }),
    };
  });
  emit();
}

/**
 * 构建某模型的对话历史：user 轮取问题；assistant 轮只取**该模型自己**的回答
 * （群聊互不串台——各模型的上下文独立，这正是多模型对比的意义）。
 * docContext 只在提供它的那一轮附加（后续轮次靠历史中的问答延续语境）。
 */
function buildMessages(
  session: ChatSession,
  uptoTurnId: string,
  modelId: string,
  docContext?: string,
): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];
  for (const turn of session.turns) {
    if (turn.id === uptoTurnId) {
      let q = turn.question;
      if (docContext) {
        q = turn.docName
          ? `以下是当前文档《${turn.docName}》的内容：\n\n${docContext}\n\n${q}`
          : `参考以下资料：\n\n${docContext}\n\n${q}`;
      }
      msgs.push({ role: "user", content: q });
      break;
    }
    msgs.push({ role: "user", content: turn.question });
    const self = turn.answers.find((a) => a.modelId === modelId);
    if (self?.content) msgs.push({ role: "assistant", content: self.content });
  }
  return msgs;
}

/**
 * 群聊发送：对会话勾选的每个模型并行发起 ai_chat。
 * requestId = `${turnId}:${modelId}`，chunk 事件在模块级监听器里按此路由。
 * 返回本轮 turnId。
 */
export function sendGroupTurn(
  sessionId: string,
  question: string,
  docContext?: string,
  docName?: string,
): string | null {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session || isInflight()) return null;
  const targets = session.modelIds.map((id) => getModelById(id)).filter(Boolean) as ChatModelEntry[];
  if (!targets.length) return null;

  const turnId = newId();
  const turn: ChatTurn = {
    id: turnId,
    question,
    docName,
    answers: targets.map((m) => ({ modelId: m.id, content: "", done: false })),
    ts: Date.now(),
  };
  sessions = sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          turns: [...s.turns, turn],
          title: s.turns.length === 0 ? question.slice(0, 24) || s.title : s.title,
        }
      : s,
  );
  emit();

  for (const m of targets) {
    const requestId = `${turnId}:${m.id}`;
    inflight.set(requestId, { sessionId, turnId, modelId: m.id });
    const latest = sessions.find((s) => s.id === sessionId);
    const msgs = buildMessages(latest ?? session, turnId, m.id, docContext);
    void invoke<string>("ai_chat", {
      request: {
        provider: m.provider,
        model: m.model,
        messages: msgs,
        baseUrl: m.baseUrl || null,
        requestId,
      },
    })
      .then((full) => {
        updateAnswer(sessionId, turnId, m.id, { content: full, done: true });
      })
      .catch((err) => {
        updateAnswer(sessionId, turnId, m.id, { done: true, error: String(err) });
      })
      .finally(() => {
        inflight.delete(requestId);
        emit();
      });
  }
  return turnId;
}

// ── 流式事件监听（模块级注册一次，跨组件生命周期） ────────────────────

let streamListenersRegistered = false;

export async function registerStreamListeners(): Promise<void> {
  if (streamListenersRegistered) return;
  streamListenersRegistered = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ requestId: string; chunk: string }>("zmd-ai-chunk", (e) => {
    const inflightEntry = inflight.get(e.payload.requestId);
    if (!inflightEntry) return;
    updateAnswer(inflightEntry.sessionId, inflightEntry.turnId, inflightEntry.modelId, {});
    const s = sessions.find((x) => x.id === inflightEntry.sessionId);
    const t = s?.turns.find((x) => x.id === inflightEntry.turnId);
    const a = t?.answers.find((x) => x.modelId === inflightEntry.modelId);
    if (a) {
      a.content += e.payload.chunk;
      emit();
    }
  });
  await listen<{ requestId: string; fullText: string }>("zmd-ai-done", (e) => {
    const inflightEntry = inflight.get(e.payload.requestId);
    if (!inflightEntry) return;
    const s = sessions.find((x) => x.id === inflightEntry.sessionId);
    const t = s?.turns.find((x) => x.id === inflightEntry.turnId);
    const a = t?.answers.find((x) => x.modelId === inflightEntry.modelId);
    if (a) {
      if (e.payload.fullText && e.payload.fullText.length >= a.content.length) a.content = e.payload.fullText;
      a.done = true;
      inflight.delete(e.payload.requestId);
      emit();
    }
  });
  await listen<{ requestId: string; error: string }>("zmd-ai-error", (e) => {
    const inflightEntry = inflight.get(e.payload.requestId);
    if (!inflightEntry) return;
    const s = sessions.find((x) => x.id === inflightEntry.sessionId);
    const t = s?.turns.find((x) => x.id === inflightEntry.turnId);
    const a = t?.answers.find((x) => x.modelId === inflightEntry.modelId);
    if (a) {
      if (e.payload.error !== "cancelled") a.error = e.payload.error;
      a.done = true;
      inflight.delete(e.payload.requestId);
      emit();
    }
  });
}
