//! AI 改写/总结/翻译/解释 —— Rust 侧代理（对照移植自 soloMD ai_proxy.rs）。
//!
//! 架构：BYOK（Bring Your Own Key），密钥存 OS 钥匙串（keyring crate），
//! 绝不进 localStorage / 绝不打日志。前端把 provider/model/system/user/selection
//! 传给 `ai_rewrite`，本模块向 provider 发起**流式** chat 请求，把增量文本经
//! Tauri 事件 `zmd-ai-chunk` 推给前端；`zmd-ai-done` / `zmd-ai-error` 终结。
//! 每个请求有唯一 request_id（可由前端预铸造传入），供事件过滤与取消。
//!
//! 支持的 wire format：
//!   - `openai` —— OpenAI Chat Completions（DeepSeek 及任意兼容端点共用同一 runner）
//!   - `ollama` —— 本地 Ollama `/api/chat` NDJSON 流（无 key）
//!
//! 取消为协作式：per-request `Arc<AtomicBool>`，每个 chunk 解析后检查，
//! 置位后下一轮循环退出并以 `zmd-ai-error` ("cancelled") 收尾。
//!
//! ⚠️ soloMD 踩坑教训（必须保留的三个行为）：
//!   1. keychain 命令必须 `async` + `spawn_blocking` —— macOS 签名变更后首次读
//!      钥匙串会弹授权框，同步命令会冻住整个窗口。
//!   2. 无 key 时不发送 `Authorization` 头 —— 部分自建服务端对空
//!      `Bearer ` 报 401，比不发更糟。
//!   3. 不发 `stream_options.include_usage` —— 部分 vLLM 分叉/网关对该字段
//!      直接 400（soloMD 的 Bug O，P0 无成本规避）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Provider / wire format
// ---------------------------------------------------------------------------

/// 归一化 wire format。P0 的 provider 集（openai-compat 自定义 / deepseek /
/// ollama）只有两种线格式；`provider` 缺省时按 id 推断。
fn wire_format(provider_or_format: &str) -> String {
    match provider_or_format {
        "ollama" => "ollama".to_string(),
        _ => "openai".to_string(),
    }
}

/// 无账号后端的 provider（本地 Ollama / 自建 OpenAI 兼容端点）：
/// key 允许缺失（有些人会加反代 token），缺失时不发 Authorization 头。
fn is_keyless_provider(provider: &str) -> bool {
    matches!(provider, "ollama" | "openai-compat")
}

/// 有 key 才加 `Authorization: Bearer`。
fn with_optional_bearer(rb: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    if key.trim().is_empty() {
        rb
    } else {
        rb.bearer_auth(key)
    }
}

/// 归一化用户手输的 OpenAI 兼容 base URL（照搬 soloMD 语义）：
///   * 空/纯空白 → None（调用方回退默认）
///   * 无 scheme → 本地 host:port / IP / localhost 补 `http://`，其余补 `https://`
///   * 尾部 `/` 去掉；无任何 path → 追加 `/v1`（已带 `/api/v3` 等则不动）
pub fn normalize_openai_base(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let has_scheme = trimmed.contains("://");
    let after_scheme = if has_scheme {
        trimmed.splitn(2, "://").nth(1).unwrap_or("")
    } else {
        trimmed
    };
    let host = after_scheme.split('/').next().unwrap_or("");
    let host_only = host.rsplit('@').next().unwrap_or(host);
    let hostname = if let Some(rest) = host_only.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host_only.split(':').next().unwrap_or("")
    };
    let looks_local = hostname == "localhost"
        || hostname.ends_with(".local")
        || hostname.parse::<std::net::IpAddr>().is_ok();
    let with_scheme = if has_scheme {
        trimmed.to_string()
    } else if looks_local || host_only.contains(':') {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };
    let path = with_scheme
        .splitn(2, "://")
        .nth(1)
        .and_then(|rest| rest.split_once('/'))
        .map(|(_, p)| p.trim_matches('/').to_string())
        .unwrap_or_default();
    let out = if path.is_empty() {
        format!("{}/v1", with_scheme.trim_end_matches('/'))
    } else {
        with_scheme.trim_end_matches('/').to_string()
    };
    Some(out)
}

fn openai_base(base_url: Option<&str>) -> String {
    base_url
        .and_then(normalize_openai_base)
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_openai_base;

    #[test]
    fn base_url_empty_is_none() {
        assert_eq!(normalize_openai_base(""), None);
        assert_eq!(normalize_openai_base("   "), None);
    }

    #[test]
    fn base_url_bare_host_gets_scheme_and_v1() {
        // llama-server / LM Studio 启动时打印的裸地址
        assert_eq!(
            normalize_openai_base("192.168.1.20:8080"),
            Some("http://192.168.1.20:8080/v1".into())
        );
        assert_eq!(
            normalize_openai_base("localhost:1234"),
            Some("http://localhost:1234/v1".into())
        );
    }

    #[test]
    fn base_url_remote_host_gets_https() {
        assert_eq!(
            normalize_openai_base("api.example.com"),
            Some("https://api.example.com/v1".into())
        );
    }

    #[test]
    fn base_url_existing_path_is_preserved() {
        assert_eq!(
            normalize_openai_base("https://api.deepseek.com/v1"),
            Some("https://api.deepseek.com/v1".into())
        );
        assert_eq!(
            normalize_openai_base("https://ark.cn-beijing.volces.com/api/v3/"),
            Some("https://ark.cn-beijing.volces.com/api/v3".into())
        );
    }
}

/// Ollama 地址：默认 `http://localhost:11434`，支持 `OLLAMA_HOST` 覆盖
/// （与 Ollama 官方 CLI 同名环境变量）。
fn ollama_base(base_url: Option<&str>) -> String {
    if let Some(raw) = base_url {
        let trimmed = raw.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            let with_scheme = if trimmed.contains("://") {
                trimmed.to_string()
            } else {
                format!("http://{trimmed}")
            };
            return with_scheme;
        }
    }
    if let Ok(h) = std::env::var("OLLAMA_HOST") {
        let h = h.trim().trim_end_matches('/');
        if !h.is_empty() {
            if h.contains("://") {
                return h.to_string();
            }
            return format!("http://{h}");
        }
    }
    "http://localhost:11434".to_string()
}

// ---------------------------------------------------------------------------
// 公开请求/事件类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRequest {
    /// 稳定 provider id（openai-compat / deepseek / ollama），作钥匙串槽位 key。
    pub provider: String,
    /// API 线格式：openai / ollama。缺省按 provider 推断。
    #[serde(default)]
    pub api_format: Option<String>,
    /// 模型 id，如 "deepseek-chat"、"qwen2.5:7b"。
    pub model: String,
    /// 系统提示词。
    pub system: String,
    /// 用户指令；选区文本由后端拼接为 `\n\nText:\n<selection>`。
    pub user: String,
    /// 用户在编辑器中选中的文本。
    pub selection: String,
    /// base URL 覆盖（自建端点 / 非默认 Ollama 端口）。空 = provider 默认。
    #[serde(default)]
    pub base_url: Option<String>,
    /// 前端预铸造的 request id（事件竞态规避：监听器先于 invoke 就绪）。
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkEvent {
    request_id: String,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    request_id: String,
    full_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    request_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// 取消注册表
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: std::sync::OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    std::sync::OnceLock::new();

static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn make_request_id() -> String {
    let n = REQ_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("req-{ts}-{n}")
}

fn register_cancel_flag(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancel_flags().lock() {
        map.insert(id.to_string(), flag.clone());
    }
    flag
}

fn drop_cancel_flag(id: &str) {
    if let Ok(mut map) = cancel_flags().lock() {
        map.remove(id);
    }
}

// ---------------------------------------------------------------------------
// 密钥存储（OS keyring；无后端时返回明确错误）
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "tydora";

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ai-{provider}"))
        .map_err(|e| format!("钥匙串条目创建失败: {e}"))
}

fn key_set(provider: &str, key: &str) -> Result<(), String> {
    let entry = keyring_entry(provider)?;
    entry
        .set_password(key)
        .map_err(|e| format!("密钥写入失败: {e}"))
}

fn key_has(provider: &str) -> Result<bool, String> {
    let entry = keyring_entry(provider)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("钥匙串读取失败: {e}")),
    }
}

fn key_clear(provider: &str) -> Result<(), String> {
    let entry = keyring_entry(provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("钥匙串删除失败: {e}")),
    }
}

fn key_read(provider: &str) -> Result<String, String> {
    let entry = keyring_entry(provider)?;
    entry
        .get_password()
        .map_err(|e| format!("钥匙串读取失败: {e}"))
}

/// keychain 命令必须 async + spawn_blocking（soloMD 教训 1：macOS 授权弹窗
/// 阻塞主线程会冻结窗口）。所有密钥命令走这个包装。
async fn keycmd<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("keychain task: {e}"))?
}

#[tauri::command]
pub async fn ai_set_key(provider: String, key: String) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("provider 不能为空".into());
    }
    if key.contains('\n') || key.contains('\r') {
        return Err("密钥不能包含换行".into());
    }
    keycmd(move || key_set(&provider, &key)).await
}

#[tauri::command]
pub async fn ai_has_key(provider: String) -> Result<bool, String> {
    keycmd(move || key_has(&provider)).await
}

#[tauri::command]
pub async fn ai_clear_key(provider: String) -> Result<(), String> {
    keycmd(move || key_clear(&provider)).await
}

// ---------------------------------------------------------------------------
// 模型列表探测（设置面板「获取模型列表 / 刷新」按钮）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbe {
    pub ok: bool,
    pub models: Vec<String>,
    /// 实际探测的地址（归一化后），供面板回显「已探测 {url}」。
    pub url: String,
    /// 失败原因原文 —— 面板要显示"为什么"而不是一个红点。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 探测端点的模型列表，填充设置面板的模型下拉。
/// OpenAI 兼容：`GET {base}/models`；Ollama：`GET {base}/api/tags`。
/// 永不返回 Err —— 失败细节随 `error` 返回（soloMD 同款约定）。
#[tauri::command]
pub async fn ai_list_models(provider: String, base_url: Option<String>) -> ModelProbe {
    let format = wire_format(&provider);
    // keyless 端点允许无 key；有 key（反代 token）则带上
    let key = keycmd(move || key_read(&provider)).await.unwrap_or_default();

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .connect_timeout(Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ModelProbe {
                ok: false,
                models: vec![],
                url: String::new(),
                error: Some(e.to_string()),
            }
        }
    };

    match format.as_str() {
        "openai" => {
            let base = openai_base(base_url.as_deref());
            let url = format!("{base}/models");
            let resp = match with_optional_bearer(client.get(&url), &key).send().await {
                Ok(r) => r,
                Err(e) => {
                    return ModelProbe {
                        ok: false,
                        models: vec![],
                        url,
                        error: Some(format!("{e}")),
                    }
                }
            };
            let status = resp.status();
            if !status.is_success() {
                let txt = resp.text().await.unwrap_or_default();
                return ModelProbe {
                    ok: false,
                    models: vec![],
                    url,
                    error: Some(format!("HTTP {status}: {}", truncate_chars(&txt, 160))),
                };
            }
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return ModelProbe {
                        ok: false,
                        models: vec![],
                        url,
                        error: Some(format!("JSON 解析失败: {e}")),
                    }
                }
            };
            // OpenAI 形状 { "data": [ { "id": ... } ] }；少数分叉回裸数组，两者都收
            let arr = json
                .get("data")
                .and_then(|d| d.as_array())
                .or_else(|| json.as_array())
                .cloned()
                .unwrap_or_default();
            let models = arr
                .iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| m.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            ModelProbe {
                ok: true,
                models,
                url,
                error: None,
            }
        }
        "ollama" => {
            let base = ollama_base(base_url.as_deref());
            let url = format!("{base}/api/tags");
            let resp = match client.get(&url).send().await {
                Ok(r) => r,
                Err(e) => {
                    return ModelProbe {
                        ok: false,
                        models: vec![],
                        url,
                        error: Some(format!("{e}")),
                    }
                }
            };
            let status = resp.status();
            if !status.is_success() {
                return ModelProbe {
                    ok: false,
                    models: vec![],
                    url,
                    error: Some(format!("HTTP {status}: Ollama 不可达")),
                };
            }
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return ModelProbe {
                        ok: false,
                        models: vec![],
                        url,
                        error: Some(format!("JSON 解析失败: {e}")),
                    }
                }
            };
            let arr = json
                .get("models")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let models = arr
                .iter()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            ModelProbe {
                ok: true,
                models,
                url,
                error: None,
            }
        }
        other => ModelProbe {
            ok: false,
            models: vec![],
            url: String::new(),
            error: Some(format!("未知 api_format: {other}")),
        },
    }
}

// ---------------------------------------------------------------------------
// 取消命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_cancel(request_id: String) -> Result<(), String> {
    if let Ok(map) = cancel_flags().lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 密钥验证（保存后绿✓/红✗）
// ---------------------------------------------------------------------------

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// 对 OpenAI 兼容端点做一次 1-token chat ping —— `GET /models` 是可选实现
/// （企业网关 / 部分自建服务端 404 它但 chat 完全正常），404 时回退到这里。
async fn openai_chat_ping(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("端点无 /models 列表且未配置模型名，无法验证".into());
    }
    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}]
    });
    let res = with_optional_bearer(client.post(&url), key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    let status = res.status();
    if status.is_success() {
        Ok(format!("OK · {model} 响应正常"))
    } else {
        let txt = res.text().await.unwrap_or_default();
        Err(format!("HTTP {status}: {}", truncate_chars(&txt, 200)))
    }
}

#[tauri::command]
pub async fn ai_verify_key(
    provider: String,
    api_format: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let format = wire_format(&api_format.unwrap_or_else(|| provider.clone()));
    let key = if is_keyless_provider(&provider) {
        // 本地/自建端点无 key 合法；有 key（反代 token）则带上
        key_read(&provider).unwrap_or_default()
    } else {
        key_read(&provider).map_err(|e| format!("尚未保存密钥: {e}"))?
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    match format.as_str() {
        "openai" => {
            let base = openai_base(base_url.as_deref());
            let url = format!("{base}/models");
            let res = with_optional_bearer(client.get(&url), &key)
                .send()
                .await
                .map_err(|e| format!("网络错误: {e}"))?;
            let status = res.status();
            if status.is_success() {
                let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                let n = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                Ok(format!("OK · 可用模型 {n} 个"))
            } else {
                let txt = res.text().await.unwrap_or_default();
                if status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    // 401/403 = 端点明确说 key 错，验证失败，不掩盖
                    return Err(format!("HTTP {status}: {}", truncate_chars(&txt, 200)));
                }
                // /models 404 等可选实现 → chat ping 回退
                match openai_chat_ping(
                    &client,
                    &base,
                    &key,
                    model.as_deref().unwrap_or(""),
                )
                .await
                {
                    Ok(msg) => Ok(msg),
                    Err(ping_err) => Err(format!(
                        "HTTP {status}: {} · {ping_err}",
                        truncate_chars(&txt, 200)
                    )),
                }
            }
        }
        "ollama" => {
            let base = ollama_base(base_url.as_deref());
            let url = format!("{base}/api/tags");
            let res = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("网络错误: {e}（Ollama 在运行吗？）"))?;
            if res.status().is_success() {
                let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                let n = body
                    .get("models")
                    .and_then(|d| d.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                Ok(format!("OK · 本地模型 {n} 个"))
            } else {
                Err(format!("HTTP {}: Ollama 不可达", res.status()))
            }
        }
        other => Err(format!("未知 api_format: {other}")),
    }
}

// ---------------------------------------------------------------------------
// 流式主命令
// ---------------------------------------------------------------------------

fn build_user_message(req: &RewriteRequest) -> String {
    format!("{}\n\nText:\n{}", req.user, req.selection)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

fn cancelled() -> String {
    "cancelled".to_string()
}

fn emit_chunk(app: &AppHandle, request_id: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    let _ = app.emit(
        "zmd-ai-chunk",
        ChunkEvent {
            request_id: request_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
}

/// SSE 事件边界：`\n\n` 或 `\r\n\r\n`。返回第一个边界起始下标。
fn find_event_boundary(buf: &str) -> Option<usize> {
    let idx_lf = buf.find("\n\n");
    let idx_crlf = buf.find("\r\n\r\n");
    match (idx_lf, idx_crlf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// 流式 AI 请求入口。同步返回 request_id；增量文本经 `zmd-ai-chunk` 事件推送，
/// `zmd-ai-done`（携带全文）或 `zmd-ai-error` 终结。
#[tauri::command]
pub async fn ai_rewrite(app: AppHandle, request: RewriteRequest) -> Result<String, String> {
    let request_id = request
        .request_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(make_request_id);
    let cancel = register_cancel_flag(&request_id);

    let format = wire_format(
        &request
            .api_format
            .clone()
            .unwrap_or_else(|| request.provider.clone()),
    );

    // 密钥：ollama 不需要；keyless provider 允许缺失；其余必须已保存
    let api_key = if format == "ollama" {
        String::new()
    } else if is_keyless_provider(&request.provider) {
        key_read(&request.provider).unwrap_or_default()
    } else {
        match key_read(&request.provider) {
            Ok(k) => k,
            Err(e) => {
                drop_cancel_flag(&request_id);
                return Err(e);
            }
        }
    };

    let id_for_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = match format.as_str() {
            "openai" => run_openai(&app, &id_for_task, &request, &api_key, cancel.clone()).await,
            "ollama" => run_ollama(&app, &id_for_task, &request, cancel.clone()).await,
            other => Err(format!("未知 api_format: {other}")),
        };
        match result {
            Ok(full_text) => {
                let _ = app.emit(
                    "zmd-ai-done",
                    DoneEvent {
                        request_id: id_for_task.clone(),
                        full_text,
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "zmd-ai-error",
                    ErrorEvent {
                        request_id: id_for_task.clone(),
                        error: err,
                    },
                );
            }
        }
        drop_cancel_flag(&id_for_task);
    });

    Ok(request_id)
}

// --- OpenAI Chat Completions（DeepSeek 等一切兼容端点共用） ------------------

async fn run_openai(
    app: &AppHandle,
    request_id: &str,
    req: &RewriteRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = openai_base(req.base_url.as_deref());
    let url = format!("{base}/chat/completions");

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": build_user_message(req)},
        ],
    });

    let client = http_client()?;
    let resp = with_optional_bearer(client.post(&url), api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate_chars(&txt, 300)));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("流读取错误: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = find_event_boundary(&buf) {
            let event = buf[..idx].to_string();
            let after = if buf[idx..].starts_with("\r\n\r\n") {
                idx + 4
            } else {
                idx + 2
            };
            buf = buf[after..].to_string();

            for line in event.lines() {
                let line = line.trim_start();
                let payload = match line.strip_prefix("data:") {
                    Some(p) => p.trim(),
                    None => continue,
                };
                if payload == "[DONE]" {
                    return Ok(full);
                }
                let json: serde_json::Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(content) = json
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|s| s.as_str())
                {
                    if !content.is_empty() {
                        full.push_str(content);
                        emit_chunk(app, request_id, content);
                    }
                }
            }
        }
    }
    Ok(full)
}

// --- Ollama /api/chat NDJSON 流 ----------------------------------------------

async fn run_ollama(
    app: &AppHandle,
    request_id: &str,
    req: &RewriteRequest,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = ollama_base(req.base_url.as_deref());
    let url = format!("{base}/api/chat");

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": build_user_message(req)},
        ],
    });

    let client = http_client()?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}（Ollama 在运行吗？）"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate_chars(&txt, 300)));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("流读取错误: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // Ollama 每行一个 JSON 对象
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf = buf[nl + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(content) = json
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|s| s.as_str())
            {
                if !content.is_empty() {
                    full.push_str(content);
                    emit_chunk(app, request_id, content);
                }
            }
            if json.get("done").and_then(|b| b.as_bool()).unwrap_or(false) {
                return Ok(full);
            }
            if let Some(err) = json.get("error").and_then(|s| s.as_str()) {
                return Err(format!("ollama: {err}"));
            }
        }
    }
    Ok(full)
}
