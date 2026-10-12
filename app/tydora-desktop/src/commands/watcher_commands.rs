//! vault 文件监听。
//!
//! ## 为什么需要引用计数
//!
//! `WatcherState` 是**全局单例**（Tauri managed state），但 `watch_vault` /
//! `unwatch_vault` 的调用方是**每个窗口各自**的 `useVaultWatcher`（主窗口、
//! 图谱窗口、脑图窗口……）。历史实现是"单槽位 + 无条件清空"：
//!
//! - 后挂载的窗口会 `*guard = Some(watcher)`，直接 drop 掉前一个 watcher；
//! - 任一窗口卸载都会 `*guard = None`，**其余窗口从此再也收不到
//!   `vault://changed`**，且没有重试机制。
//!
//! 现在按「被监听目录」分别持有 watcher，并各记一个引用计数：
//! 只有最后一个使用者退出时才真正停止监听。不同窗口监控不同 vault 也互不干扰。

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// 一个被监听的目录及其使用者数量。
pub struct WatchedVault {
    watcher: RecommendedWatcher,
    /// 被监听的目录（drop 时用于显式停止监听）
    path: String,
    refs: usize,
}

impl Drop for WatchedVault {
    fn drop(&mut self) {
        // 引用计数归零 → 显式停止监听并释放句柄，不必等 Drop 链隐式回收
        let _ = self.watcher.unwatch(std::path::Path::new(&self.path));
    }
}

#[derive(Default)]
pub struct WatcherState(pub Mutex<HashMap<String, WatchedVault>>);

#[derive(serde::Serialize, Clone)]
struct FsEvent {
    kind: String,
    paths: Vec<String>,
}

/// 归一化监听目标，作为 map key（同一目录的不同写法视为同一个）。
///
/// 用 `canonicalize()` 消除尾斜杠 / 大小写 / 相对路径差异；目录不存在或
/// 无权限时回退为原始字符串 —— 此时 `watch()` 会自己报错。
fn watcher_key(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[tauri::command]
pub fn watch_vault(
    path: String,
    app: AppHandle,
    state: State<WatcherState>,
) -> Result<(), String> {
    let key = watcher_key(&path);
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // 已有同目录 watcher：只加引用，不重建（避免多个窗口互相顶掉）
    if let Some(existing) = guard.get_mut(&key) {
        existing.refs += 1;
        return Ok(());
    }

    let app_clone = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                let kind = format!("{:?}", event.kind);
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .collect();

                let _ = app_clone.emit("vault://changed", FsEvent { kind, paths });
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    guard.insert(
        key,
        WatchedVault {
            watcher,
            path: path.clone(),
            refs: 1,
        },
    );
    Ok(())
}

/// 释放一次对某目录的监听。
///
/// - `path` 为 `Some`：仅减该目录的引用计数，减到 0 才停止监听
/// - `path` 为 `None`：兼容旧调用方 —— 全部释放
#[tauri::command]
pub fn unwatch_vault(
    path: Option<String>,
    state: State<WatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    match path {
        Some(p) => {
            let key = watcher_key(&p);
            // 归一化失败时按原样再试一次，避免键不一致导致计数泄漏
            let key = if guard.contains_key(&key) { key } else { p };
            if let Some(entry) = guard.get_mut(&key) {
                entry.refs = entry.refs.saturating_sub(1);
                if entry.refs == 0 {
                    guard.remove(&key);
                }
            }
        }
        None => guard.clear(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_key_normalizes_trailing_separator() {
        let dir = std::env::temp_dir();
        let plain = watcher_key(&dir.to_string_lossy());
        let with_sep = watcher_key(&format!("{}{}", dir.to_string_lossy(), std::path::MAIN_SEPARATOR));
        assert_eq!(
            plain, with_sep,
            "same directory written with a trailing separator must map to one key"
        );
    }

    #[test]
    fn watcher_key_falls_back_for_missing_path() {
        let missing = "definitely/not/a/real/directory/xyz";
        assert_eq!(watcher_key(missing), missing);
    }
}
