/**
 * AI 设置页 UI（设置窗口内）——对照 soloMD「设置 → 集成 → AI 改写」布局移植。
 *
 * 结构（canvas-settings-* 卡片风格）：
 * - 启用开关（settings-switch）
 * - 服务商下拉（SettingsSelect：OpenAI 兼容 / DeepSeek / Ollama）
 * - 接口地址（Base URL，本地草稿，失焦提交）
 * - 探测行：「● 已连接 · N 个模型 · 已探测 {url}」状态胶囊 + 获取/刷新按钮
 * - 模型：探测成功后为下拉（列表来自 GET /models）；未探测时退回文本输入
 * - API Key（可选）：保存并验证（成功后自动拉取模型列表）+ 清除
 *
 * 密钥永远走 Rust 钥匙串命令；本组件不持有 key 状态（只留输入框草稿）。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { SettingsSelect } from "../components/SettingsSelect";
import { PROVIDERS, providerById } from "./providers";
import { loadAISettings, saveAISettings, type AISettings } from "./aiSettings";
import "./AISettings.css";

/** Rust `ai_list_models` 的返回（tydora.modelProbe 语义，camelCase）。 */
interface ModelProbe {
  ok: boolean;
  models: string[];
  url: string;
  error: string | null;
}

export function AISettingsContent() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AISettings>(() => loadAISettings());
  const [keyDraft, setKeyDraft] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [probe, setProbe] = useState<ModelProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");

  const provider = providerById(settings.provider);
  const isKeyless = provider?.keyless ?? false;
  const model = settings.models[settings.provider] ?? provider?.defaultModel ?? "";

  // provider 切换（含首次挂载）：回填草稿 + 作废旧的模型探测结果
  useEffect(() => {
    const p = providerById(settings.provider);
    setModelDraft(settings.models[settings.provider] ?? p?.defaultModel ?? "");
    setBaseUrlDraft(settings.baseUrls[settings.provider] ?? p?.defaultBaseUrl ?? "");
    setKeyDraft("");
    setKeyMsg(null);
    setProbe(null);
  }, [settings.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // key 存在性（不读内容）
  useEffect(() => {
    void invoke<boolean>("ai_has_key", { provider: settings.provider })
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [settings.provider, keyMsg]);

  const update = (patch: Partial<AISettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveAISettings(next);
  };

  const commitModel = () => {
    const trimmed = modelDraft.trim();
    if (trimmed === (settings.models[settings.provider] ?? provider?.defaultModel ?? "")) return;
    update({ models: { ...settings.models, [settings.provider]: trimmed } });
  };

  const commitBaseUrl = () => {
    const trimmed = baseUrlDraft.trim();
    if (trimmed === (settings.baseUrls[settings.provider] ?? provider?.defaultBaseUrl ?? "")) return;
    update({ baseUrls: { ...settings.baseUrls, [settings.provider]: trimmed } });
  };

  /** 探测当前端点的模型列表（「获取模型列表 / 刷新」按钮）。 */
  const fetchModels = async () => {
    setProbing(true);
    try {
      const p = await invoke<ModelProbe>("ai_list_models", {
        provider: settings.provider,
        baseUrl: baseUrlDraft.trim() || provider?.defaultBaseUrl || null,
      });
      setProbe(p);
      // 探测成功且尚未选模型 → 自动选第一个（soloMD：面板从 /models 填充默认）
      if (p.ok && p.models.length > 0) {
        const cur = (settings.models[settings.provider] ?? provider?.defaultModel ?? "").trim();
        if (!cur) {
          update({ models: { ...settings.models, [settings.provider]: p.models[0] } });
          setModelDraft(p.models[0]);
        }
      }
    } catch (e) {
      setProbe({ ok: false, models: [], url: "", error: String(e) });
    } finally {
      setProbing(false);
    }
  };

  /** 保存 key（如有）→ 验证连接 → 成功后自动拉取模型列表填充下拉。 */
  const saveAndVerify = async () => {
    setBusy(true);
    setKeyMsg(null);
    try {
      const k = keyDraft.trim();
      if (k) {
        await invoke("ai_set_key", { provider: settings.provider, key: k });
        setKeyDraft("");
      }
      const msg = await invoke<string>("ai_verify_key", {
        provider: settings.provider,
        apiFormat: provider?.apiFormat ?? null,
        baseUrl: baseUrlDraft.trim() || provider?.defaultBaseUrl || null,
        model: modelDraft.trim() || model.trim() || null,
      });
      setKeyMsg({ ok: true, text: msg });
      await fetchModels();
    } catch (e) {
      setKeyMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setKeyMsg(null);
    try {
      await invoke("ai_clear_key", { provider: settings.provider });
      setProbe(null);
      setKeyMsg({ ok: true, text: t("settings.ai.keyCleared") });
    } catch (e) {
      setKeyMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // ── 模型下拉选项：探测列表 + 当前值合并（当前值不在列表时补一项） ──
  const curModel = model.trim();
  const modelOptions: Array<{ value: string; label: string }> = [];
  if (curModel && !probe?.models.includes(curModel)) {
    modelOptions.push({ value: curModel, label: curModel });
  }
  if (!curModel) {
    modelOptions.push({ value: "", label: t("settings.ai.modelSelectPlaceholder") });
  }
  for (const m of probe?.models ?? []) modelOptions.push({ value: m, label: m });

  return (
    <div className="canvas-settings-page">
      {/* 启用 + 服务商 + 地址 + 探测 + 模型 */}
      <div className="canvas-settings-card">
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.enable")}</span>
            <span className="canvas-settings-row-desc">{t("settings.ai.enableDesc")}</span>
          </div>
          <div className="canvas-settings-row-control">
            <label className="settings-switch">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              <span className="settings-switch-slider" />
            </label>
          </div>
        </div>
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.provider")}</span>
            <span className="canvas-settings-row-desc">{t("settings.ai.providerDesc")}</span>
          </div>
          <div className="canvas-settings-row-control">
            <SettingsSelect
              value={settings.provider}
              onChange={(v) => update({ provider: v as AISettings["provider"] })}
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
              minWidth={260}
            />
          </div>
        </div>
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.baseUrl")}</span>
            <span className="canvas-settings-row-desc">{t("settings.ai.baseUrlDesc")}</span>
          </div>
          <div className="canvas-settings-row-control">
            <input
              className="settings-input"
              value={baseUrlDraft}
              placeholder={provider?.defaultBaseUrl ?? ""}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              onBlur={commitBaseUrl}
              onKeyDown={(e) => e.key === "Enter" && commitBaseUrl()}
            />
          </div>
        </div>
        {/* API Key：紧贴接口地址下方（填完 URL → 填 Key → 保存并验证 → 获取模型列表） */}
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.apiKey")}</span>
            <span className="canvas-settings-row-desc">
              {isKeyless
                ? t("settings.ai.apiKeyOptionalDesc")
                : `${t("settings.ai.apiKeyDesc")}${hasKey ? " · " + t("settings.ai.keyPresent") : ""}`}
              {provider?.signupUrl && (
                <>
                  {" "}
                  <a href={provider.signupUrl} target="_blank" rel="noreferrer" className="settings-link">
                    {t("settings.ai.getKey")}
                  </a>
                </>
              )}
            </span>
          </div>
          <div className="canvas-settings-row-control ai-key-row">
            <input
              className="settings-input"
              type="password"
              value={keyDraft}
              placeholder={isKeyless ? t("settings.ai.keyOptional") : t("settings.ai.keyPlaceholder")}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveAndVerify()}
            />
            <button
              className="settings-button"
              disabled={busy}
              onClick={() => void saveAndVerify()}
            >
              {t("settings.ai.saveKey")}
            </button>
            {!isKeyless && hasKey && (
              <button className="settings-button" disabled={busy} onClick={() => void clearKey()}>
                {t("settings.ai.clearKey")}
              </button>
            )}
          </div>
          {keyMsg && (
            <div className={`ai-key-msg${keyMsg.ok ? " ok" : " err"}`}>{keyMsg.text}</div>
          )}
        </div>
        {/* 探测状态行：胶囊 + 已探测地址 + 获取/刷新按钮 */}
        <div className="canvas-settings-row ai-probe-row">
          <div className="ai-probe-status">
            {probe && (
              <>
                <span className={`ai-probe-pill${probe.ok ? " ok" : " err"}`}>
                  {probe.ok
                    ? `● ${t("settings.ai.probeConnected", { count: probe.models.length })}`
                    : `● ${t("settings.ai.probeFailed")}`}
                </span>
                {probe.ok && (
                  <span className="ai-probe-url">{t("settings.ai.probedAt", { url: probe.url })}</span>
                )}
              </>
            )}
            <button
              className="settings-button ai-probe-btn"
              disabled={probing || busy}
              onClick={() => void fetchModels()}
            >
              {probing ? t("settings.ai.probing") : probe ? t("settings.ai.refresh") : t("settings.ai.fetchModels")}
            </button>
          </div>
          {probe?.error && <div className="ai-probe-err">{probe.error}</div>}
        </div>
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.model")}</span>
            <span className="canvas-settings-row-desc">
              {provider?.modelHint ? `${t("settings.ai.modelDesc")} · ${provider.modelHint}` : t("settings.ai.modelDesc")}
            </span>
          </div>
          <div className="canvas-settings-row-control">
            {probe?.ok && probe.models.length > 0 ? (
              <SettingsSelect
                value={curModel}
                onChange={(v) => {
                  update({ models: { ...settings.models, [settings.provider]: v } });
                  setModelDraft(v);
                }}
                options={modelOptions}
                minWidth={240}
              />
            ) : (
              <input
                className="settings-input"
                value={modelDraft}
                placeholder={t("settings.ai.modelPlaceholder")}
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={commitModel}
                onKeyDown={(e) => e.key === "Enter" && commitModel()}
              />
            )}
          </div>
        </div>
      </div>

      <div className="canvas-settings-card">
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-title">{t("settings.ai.usage")}</span>
            <span className="canvas-settings-row-desc">{t("settings.ai.usageDesc")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
